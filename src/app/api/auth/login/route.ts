import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  verifyPassword,
  createToken,
  setAuthCookie,
  verifyMfaToken,
} from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  try {
    // Rate limit: 10 login attempts per 15 minutes per IP
    const ip = getClientIp(request);
    if (!checkRateLimit(`login:${ip}`, 10, 15 * 60 * 1000)) {
      return NextResponse.json(
        { error: "Too many login attempts. Please try again later." },
        { status: 429 }
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
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
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
        return NextResponse.json(
          { error: "Invalid MFA code" },
          { status: 401 }
        );
      }
    }

    // If an admin has flagged the user with mustEnableMfa and they don't yet
    // have MFA enabled, issue a session-locked cookie. proxy.ts will pin them
    // to /setup-mfa until they enrol.
    const pendingMfaEnrollment = user.mustEnableMfa && !user.mfaEnabled;

    const token = await createToken({
      sub: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
      pendingMfaEnrollment,
    });

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

    setAuthCookie(response, token);
    return response;
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ error: "Login failed. Please try again." }, { status: 500 });
  }
}
