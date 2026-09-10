import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  createToken,
  getAuthFromRequest,
  setAuthCookie,
  verifyMfaToken,
  isRequestSecure,
  DEFAULT_IDLE_MS,
  accountDisabledResponse,
} from "@/lib/auth";
import { isUserDisabled, isSessionEpochStale } from "@/lib/user-status";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// POST: Verify a TOTP code and enable MFA
export async function POST(request: NextRequest) {
  const authUser = await getAuthFromRequest(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // These enrolment routes use `getAuthFromRequest` rather than `requireAuth`,
  // because they must stay reachable while the session is pending MFA
  // enrolment. That means the checks `requireAuth` performs are not inherited
  // and have to be explicit — without them a *suspended* account could still
  // rewrite its own MFA secret and complete enrolment, and on the
  // `mustEnableMfa` path be handed a fresh, unlocked session cookie.
  if (await isUserDisabled(authUser.sub)) return accountDisabledResponse();
  if (await isSessionEpochStale(authUser.sub, authUser.sessionEpoch)) {
    return accountDisabledResponse();
  }

  // Rate limit: 5 MFA attempts per 15 minutes per user+IP
  const ip = getClientIp(request);
  const limit = await checkRateLimit(`mfa:${authUser.sub}:${ip}`, 5, 15 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } }
    );
  }

  const body = await request.json();
  const { code } = body;

  if (!code) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.sub } });
  if (!user || !user.mfaSecret) {
    return NextResponse.json(
      { error: "MFA setup not initiated" },
      { status: 400 }
    );
  }

  if (!verifyMfaToken(user.mfaSecret, code)) {
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { mfaEnabled: true, mustEnableMfa: false },
  });

  const response = NextResponse.json({ success: true });

  // If the session was locked by the pendingMfaEnrollment claim, re-issue a
  // normal cookie so the user can navigate the app immediately.
  if (authUser.pendingMfaEnrollment) {
    // Preserve the original login's absolute-cap anchor and idle window so
    // completing enrolment doesn't reset the session clock.
    const idleMs = authUser.idleMs ?? DEFAULT_IDLE_MS;
    const newToken = await createToken(
      {
        sub: updated.id,
        username: updated.username,
        role: updated.role,
        displayName: updated.displayName,
        sessionEpoch: updated.sessionEpoch,
      },
      { idleMs, sessionStart: authUser.sessionStart }
    );
    setAuthCookie(response, newToken, isRequestSecure(request), idleMs / 1000);
  }

  return response;
}
