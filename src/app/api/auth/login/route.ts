import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  verifyPassword,
  createToken,
  setAuthCookie,
  verifyMfaToken,
} from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { username, password, mfaCode } = body;

    if (!username || !password) {
      return NextResponse.json(
        { error: "Username and password are required" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { username } });
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

    const token = await createToken({
      sub: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
    });

    const response = NextResponse.json({
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
    });

    setAuthCookie(response, token);
    return response;
  } catch (error) {
    console.error("Login error:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
