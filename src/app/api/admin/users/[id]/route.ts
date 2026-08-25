import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { invalidateUserStatusCache } from "@/lib/user-status";

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
 * deleted or disabled. Disabled accounts are excluded deliberately: a suspended
 * SuperAdmin can't administer anything, so counting them would let the last
 * usable SuperAdmin be removed and lock everyone out of admin.
 */
async function countOtherUsableSuperAdmins(userId: number): Promise<number> {
  return prisma.user.count({
    where: { role: "SuperAdmin", disabledAt: null, id: { not: userId } },
  });
}

// PUT: update display name, role, and (optionally) company assignments
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin(request);
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

  // Prevent demoting the last SuperAdmin (was previously "Admin", now SuperAdmin)
  if (role && role !== "SuperAdmin") {
    const current = await prisma.user.findUnique({ where: { id: userId } });
    if (current?.role === "SuperAdmin") {
      if ((await countOtherUsableSuperAdmins(userId)) === 0) {
        return NextResponse.json(
          { error: "Cannot demote the last SuperAdmin" },
          { status: 400 }
        );
      }
    }
  }

  const effectiveRole = role ?? (await prisma.user.findUnique({ where: { id: userId }, select: { role: true } }))?.role;

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

  const withCompanies = await prisma.user.findUnique({
    where: { id: user.id },
    select: USER_SELECT,
  });

  return NextResponse.json({
    ...withCompanies,
    companies: withCompanies?.companies.map((c) => c.company) ?? [],
  });
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
