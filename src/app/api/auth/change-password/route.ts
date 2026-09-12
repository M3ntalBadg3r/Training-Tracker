import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getAuthFromRequest,
  verifyPassword,
  hashPassword,
  validatePassword,
  createToken,
  setAuthCookie,
  isRequestSecure,
  accountDisabledResponse,
  DEFAULT_IDLE_MS,
} from "@/lib/auth";
import {
  isUserDisabled,
  isUserDeleted,
  isSessionEpochStale,
  invalidateUserStatusCache,
} from "@/lib/user-status";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const authUser = await getAuthFromRequest(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // This route uses `getAuthFromRequest` rather than `requireAuth`, so the
  // revocation checks have to be spelled out — a suspended or deleted account
  // must not be able to change its own password, and neither must a session that
  // a password change elsewhere has already ended. This route re-issues the
  // caller's cookie, so the checks belong here, before anything is minted.
  if (await isUserDisabled(authUser.sub)) return accountDisabledResponse();
  if (await isUserDeleted(authUser.sub)) return accountDisabledResponse();
  if (await isSessionEpochStale(authUser.sub, authUser.sessionEpoch)) {
    return accountDisabledResponse();
  }
  // Not reachable during forced MFA enrolment — `proxy.ts` refuses this path
  // and the re-issued token below preserves `pendingMfaEnrollment` anyway — but
  // checked here so the edge is not the only thing enforcing it.
  if (authUser.pendingMfaEnrollment) {
    return NextResponse.json({ error: "MFA enrollment required" }, { status: 403 });
  }

  // Throttle so a stolen cookie can't brute-force the current password.
  const ip = getClientIp(request);
  const limit = await checkRateLimit(`change-pw:${authUser.sub}:${ip}`, 5, 15 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  const body = await request.json();
  const { currentPassword, newPassword } = body;

  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      { error: "Current password and new password are required" },
      { status: 400 }
    );
  }

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.sub } });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    return NextResponse.json(
      { error: "Current password is incorrect" },
      { status: 401 }
    );
  }

  const newHash = await hashPassword(newPassword);
  // Bumping sessionEpoch strands every token minted before now — including the
  // stolen cookie that may be the reason for this change. Without it the old
  // password's sessions stay valid to the absolute session cap.
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash, sessionEpoch: { increment: 1 } },
  });
  invalidateUserStatusCache();

  const response = NextResponse.json({ success: true });

  // ...except this one. Re-issue the cookie with the new epoch so the browser
  // that just changed its own password isn't signed out by its own action. The
  // original login's absolute-cap anchor and idle window are preserved, so this
  // does not extend the session (same pattern as /api/auth/mfa/verify).
  const idleMs = authUser.idleMs ?? DEFAULT_IDLE_MS;
  const token = await createToken(
    {
      sub: updated.id,
      username: updated.username,
      role: updated.role,
      displayName: updated.displayName,
      pendingMfaEnrollment: authUser.pendingMfaEnrollment,
      sessionEpoch: updated.sessionEpoch,
    },
    { idleMs, sessionStart: authUser.sessionStart }
  );
  setAuthCookie(response, token, isRequestSecure(request), idleMs / 1000);

  return response;
}
