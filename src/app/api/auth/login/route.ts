import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  verifyPassword,
  createToken,
  setAuthCookie,
  verifyMfaToken,
  isRequestSecure,
} from "@/lib/auth";
import {
  checkRateLimit,
  getClientIp,
  LOGIN_IP_MAX_ATTEMPTS,
  LOGIN_IP_WINDOW_MS,
} from "@/lib/rate-limit";
import {
  isLockedOut,
  registerFailure,
  registerSuccess,
} from "@/lib/login-attempts";
import { recordLoginFailure } from "@/lib/failed-attempts";
import { getSessionIdleMinutes } from "@/lib/system-settings";

function retryAfterResponse(message: string, retryAfterMs: number) {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return NextResponse.json(
    { error: message },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
  );
}

export async function POST(request: NextRequest) {
  try {
    // First line of defence: per-IP rate limit (10 attempts / 15 min).
    const ip = getClientIp(request);
    const ipLimit = await checkRateLimit(`login:${ip}`, LOGIN_IP_MAX_ATTEMPTS, LOGIN_IP_WINDOW_MS);
    if (!ipLimit.allowed) {
      return retryAfterResponse(
        "Too many login attempts. Please try again later.",
        ipLimit.retryAfterMs
      );
    }

    const body = await request.json();
    const { username, password, mfaCode } = body;

    if (!username || !password) {
      return NextResponse.json(
        { error: "Username and password are required" },
        { status: 400 }
      );
    }

    // Usernames are stored lowercase so login is case-insensitive.
    const normalizedUsername = String(username).toLowerCase();
    const user = await prisma.user.findUnique({ where: { username: normalizedUsername } });
    if (!user) {
      recordLoginFailure({ username: normalizedUsername, ip, reason: "unknown_user" });
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    // Second line of defence: per-account lockout. A locked account is refused
    // even with the correct password until the (escalating) lock expires. The
    // 429 message is deliberately generic so it can't be used to enumerate
    // accounts.
    const lock = isLockedOut(user);
    if (lock.locked) {
      return retryAfterResponse(
        "Too many login attempts. Please try again later.",
        lock.retryAfterMs
      );
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      await registerFailure(user.id);
      recordLoginFailure({ username: normalizedUsername, ip, reason: "bad_password" });
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    // A disabled account is refused even with the right credentials. Checked
    // *after* the password so bcrypt always runs (no timing side-channel that
    // would distinguish a disabled account from an unknown one) and *before*
    // MFA so the user is never asked for a code they can't use. The error is
    // the same generic string as a bad password — a disabled account must not
    // be enumerable — and we return before registerSuccess, so lastLoginAt
    // isn't stamped. No registerFailure either: there is nothing to gain from
    // locking an account that is already suspended.
    if (user.disabledAt) {
      recordLoginFailure({ username: normalizedUsername, ip, reason: "disabled_account" });
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    // MFA check
    if (user.mfaEnabled && user.mfaSecret) {
      if (!mfaCode) {
        return NextResponse.json({ mfaRequired: true }, { status: 200 });
      }
      if (!verifyMfaToken(user.mfaSecret, mfaCode)) {
        await registerFailure(user.id);
        recordLoginFailure({ username: normalizedUsername, ip, reason: "bad_mfa" });
        return NextResponse.json(
          { error: "Invalid MFA code" },
          { status: 401 }
        );
      }
    }

    // Fully authenticated — clear any accumulated failure/lock state.
    await registerSuccess(user);

    // If an admin has flagged the user with mustEnableMfa and they don't yet
    // have MFA enabled, issue a session-locked cookie. proxy.ts will pin them
    // to /setup-mfa until they enrol.
    const pendingMfaEnrollment = user.mustEnableMfa && !user.mfaEnabled;

    const idleMs = (await getSessionIdleMinutes()) * 60 * 1000;
    const token = await createToken(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
        displayName: user.displayName,
        pendingMfaEnrollment,
      },
      { idleMs, sessionStart: Date.now() }
    );

    // Fire-and-forget last-login update so we don't add DB latency to login.
    void prisma.user
      .update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: ip },
      })
      .catch((err) => console.error("Failed to update last-login fields:", err));

    const response = NextResponse.json({
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
      pendingMfaEnrollment,
    });

    setAuthCookie(response, token, isRequestSecure(request), idleMs / 1000);
    return response;
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ error: "Login failed. Please try again." }, { status: 500 });
  }
}
