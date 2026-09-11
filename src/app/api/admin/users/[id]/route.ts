import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  DEFAULT_IDLE_MS,
  createToken,
  handleAuthError,
  isRequestSecure,
  requireSuperAdmin,
  setAuthCookie,
} from "@/lib/auth";
import {
  countUsableSuperAdmins,
  invalidateUserStatusCache,
} from "@/lib/user-status";

const VALID_ROLES = new Set(["SuperAdmin", "Admin", "User"]);

// Row shape returned to /admin/users, matching the list route's GET.
const USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  role: true,
  mfaEnabled: true,
  mustEnableMfa: true,
  lastLoginAt: true,
  lastLoginIp: true,
  disabledAt: true,
  disabledBy: true,
  disabledReason: true,
  createdAt: true,
  companies: { select: { company: { select: { id: true, name: true } } } },
} as const;

/**
 * How many *other* SuperAdmins could still sign in if this one were demoted,
 * deleted or disabled. The "usable" predicate (enabled, not suspended) lives in
 * lib/user-status.ts so this guard and the backup restore share one definition.
 */
async function countOtherUsableSuperAdmins(userId: number): Promise<number> {
  return countUsableSuperAdmins(userId);
}

// PUT: update display name, role, and (optionally) company assignments
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let actor;
  try {
    actor = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const userId = parseInt(id, 10);
  if (isNaN(userId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const body = await request.json();
  const { displayName, role, companyIds, mustEnableMfa } = body as {
    displayName?: string;
    role?: string;
    companyIds?: number[] | null;
    mustEnableMfa?: boolean;
  };

  if (role && !VALID_ROLES.has(role)) {
    return NextResponse.json({ error: "Role must be SuperAdmin, Admin, or User" }, { status: 400 });
  }

  // One read of the current row, used by the last-SuperAdmin guard, by
  // effectiveRole, and by the session-revocation decision below. This used to be
  // two separate findUniques on different branches, neither of which noticed a
  // missing user — the update then threw P2025 and surfaced as a 500.
  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, mustEnableMfa: true, mfaEnabled: true },
  });
  if (!current) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Prevent demoting the last SuperAdmin (was previously "Admin", now SuperAdmin)
  if (role && role !== "SuperAdmin" && current.role === "SuperAdmin") {
    if ((await countOtherUsableSuperAdmins(userId)) === 0) {
      return NextResponse.json(
        { error: "Cannot demote the last SuperAdmin" },
        { status: 400 }
      );
    }
  }

  const effectiveRole = role ?? current.role;

  /**
   * Does this edit change what the user is allowed to do?
   *
   * Both `role` and `pendingMfaEnrollment` are carried IN THE TOKEN, and
   * `proxy.ts` re-signs a sliding session preserving every claim without ever
   * consulting the database — so neither authorization check that reads them
   * (the proxy's SUPER_ADMIN_PREFIXES gate and `requireSuperAdmin`) can notice
   * this write. Without a revocation lever a demotion did not take effect until
   * the 8h absolute cap, and `company-scope.ts` made that worse than it looks:
   * `getAuthorizedCompanyIds` short-circuits on the *token* role and returns
   * null ("unrestricted") for a SuperAdmin, so a demoted SuperAdmin kept
   * unrestricted company access across every scoped read.
   *
   * `pendingMfaEnrollment` is computed only at login (`auth/login`), so flagging
   * a user with a live session did nothing at all until they next signed in.
   * It is included here for the same reason and by the same mechanism.
   */
  const nextMustEnableMfa =
    typeof mustEnableMfa === "boolean" ? mustEnableMfa : current.mustEnableMfa;
  const roleChanged = Boolean(role) && role !== current.role;
  const pendingChanged =
    (current.mustEnableMfa && !current.mfaEnabled) !==
    (nextMustEnableMfa && !current.mfaEnabled);
  const revokesSessions = roleChanged || pendingChanged;

  // Replace company assignments if the caller provided an array.
  const shouldReplaceCompanies = Array.isArray(companyIds);
  const ids = shouldReplaceCompanies
    ? (companyIds as number[]).filter((n) => Number.isInteger(n))
    : [];

  // SuperAdmin doesn't get per-company links — clear them on promotion.
  const newLinks = effectiveRole === "SuperAdmin" ? [] : ids;

  if (shouldReplaceCompanies && newLinks.length > 0) {
    const found = await prisma.company.findMany({
      where: { id: { in: newLinks } },
      select: { id: true },
    });
    if (found.length !== newLinks.length) {
      return NextResponse.json({ error: "One or more companies not found" }, { status: 400 });
    }
  }

  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        ...(displayName && { displayName }),
        ...(role && { role: role as "SuperAdmin" | "Admin" | "User" }),
        ...(typeof mustEnableMfa === "boolean" && { mustEnableMfa }),
        // Strands every token minted before this edit, so the new role (or the
        // new enrolment requirement) is enforced on the user's very next
        // request instead of whenever their session happens to end. Matches
        // change-password / reset-password: `increment`, never `set`.
        ...(revokesSessions && { sessionEpoch: { increment: 1 } }),
      },
    });

    if (shouldReplaceCompanies || effectiveRole === "SuperAdmin") {
      await tx.userCompany.deleteMany({ where: { userId } });
      if (newLinks.length > 0) {
        await tx.userCompany.createMany({
          data: newLinks.map((cid) => ({ userId, companyId: cid })),
          skipDuplicates: true,
        });
      }
    }

    return updated;
  });

  if (revokesSessions) {
    // The 15s snapshot in user-status.ts would otherwise hold the old epoch,
    // and the point of the bump is that it takes effect immediately.
    invalidateUserStatusCache();
  }

  const withCompanies = await prisma.user.findUnique({
    where: { id: user.id },
    select: USER_SELECT,
  });

  const response = NextResponse.json({
    ...withCompanies,
    companies: withCompanies?.companies.map((c) => c.company) ?? [],
  });

  // A SuperAdmin editing their own row would otherwise be signed out by their
  // own action, since the bump strands the cookie they are holding. Re-issue it
  // with the NEW claims instead: they keep working, at whatever authority they
  // just gave themselves — a self-demotion takes effect on the next request
  // rather than being quietly deferred, which is the whole point of the bump.
  //
  // sessionStart and idleMs are carried over, so this refreshes the claims
  // without extending the 8h absolute cap (same pattern as change-password and
  // mfa/verify). `/api/admin/users/` is in COOKIE_AUTHORITATIVE_PREFIXES so the
  // proxy does not also write a tt-auth cookie on this response — two
  // Set-Cookie headers for one name and the stale one can win.
  if (revokesSessions && userId === actor.sub) {
    const idleMs = actor.idleMs ?? DEFAULT_IDLE_MS;
    const token = await createToken(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
        displayName: user.displayName,
        pendingMfaEnrollment: user.mustEnableMfa && !user.mfaEnabled,
        sessionEpoch: user.sessionEpoch,
      },
      { idleMs, sessionStart: actor.sessionStart }
    );
    setAuthCookie(response, token, isRequestSecure(request), idleMs / 1000);
  }

  return response;
}

// PATCH: suspend or restore an account. Kept separate from PUT (which edits
// profile/role/scope) and shaped like api/admin/api-keys/[id], the other
// enable/disable toggle in the app.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let authUser;
  try {
    authUser = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const userId = parseInt(id, 10);
  if (isNaN(userId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const body = await request.json();
  const { disabled, reason } = body as { disabled?: boolean; reason?: string };

  if (typeof disabled !== "boolean") {
    return NextResponse.json({ error: "`disabled` must be true or false" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (disabled) {
    if (userId === authUser.sub) {
      return NextResponse.json({ error: "Cannot disable your own account" }, { status: 400 });
    }
    // Belt and braces: the self-check above already means the caller is a
    // second usable SuperAdmin, so this can't fire today. It is here so the
    // invariant survives if self-disable is ever allowed.
    if (target.role === "SuperAdmin" && (await countOtherUsableSuperAdmins(userId)) === 0) {
      return NextResponse.json({ error: "Cannot disable the last SuperAdmin" }, { status: 400 });
    }
  }

  const trimmedReason = typeof reason === "string" ? reason.trim() : "";

  const updated = await prisma.user.update({
    where: { id: userId },
    data: disabled
      ? {
          disabledAt: new Date(),
          disabledBy: authUser.username,
          disabledReason: trimmedReason || null,
        }
      : { disabledAt: null, disabledBy: null, disabledReason: null },
    select: USER_SELECT,
  });

  // Take effect on the target's very next request rather than at the end of
  // the cache TTL.
  invalidateUserStatusCache();

  return NextResponse.json({
    ...updated,
    companies: updated.companies.map((c) => c.company),
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let authUser;
  try {
    authUser = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const userId = parseInt(id, 10);
  if (isNaN(userId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  if (userId === authUser.sub) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  const targetUser = await prisma.user.findUnique({ where: { id: userId } });
  if (targetUser?.role === "SuperAdmin") {
    if ((await countOtherUsableSuperAdmins(userId)) === 0) {
      return NextResponse.json({ error: "Cannot delete the last SuperAdmin" }, { status: 400 });
    }
  }

  await prisma.user.delete({ where: { id: userId } });
  return NextResponse.json({ success: true });
}
