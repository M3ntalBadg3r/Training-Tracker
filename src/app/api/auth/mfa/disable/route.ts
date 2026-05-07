import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireFullSession,
  verifyPassword,
  verifyMfaToken,
  handleAuthError,
} from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// POST: Disable MFA for the current user (own password required) OR for a
// different user (SuperAdmin only — must re-authenticate with their own
// password and, if they have MFA enabled, a current TOTP code). The
// SuperAdmin path is the dangerous one — without step-up auth, a stolen
// admin cookie would be enough to permanently disable MFA on every account.
export async function POST(request: NextRequest) {
  let authUser;
  try {
    authUser = await requireFullSession(request);
  } catch (error) {
    return handleAuthError(error);
  }

  // Per-IP throttling so a compromised cookie can't sweep the account list.
  const ip = getClientIp(request);
  if (!checkRateLimit(`mfa-disable:${ip}`, 10, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 },
    );
  }

  const body = await request.json();
  const { userId, password, mfaCode } = body as {
    userId?: number;
    password?: string;
    mfaCode?: string;
  };

  // ---- SuperAdmin disabling MFA for someone else ----------------------------
  if (typeof userId === "number" && userId !== authUser.sub) {
    if (authUser.role !== "SuperAdmin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!password) {
      return NextResponse.json(
        { error: "Your current password is required to disable another user's MFA" },
        { status: 400 },
      );
    }

    const me = await prisma.user.findUnique({ where: { id: authUser.sub } });
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const passwordValid = await verifyPassword(password, me.passwordHash);
    if (!passwordValid) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    // If the calling SuperAdmin has MFA enabled, also require a current code.
    if (me.mfaEnabled && me.mfaSecret) {
      if (!mfaCode || !verifyMfaToken(me.mfaSecret, mfaCode)) {
        return NextResponse.json(
          { error: "MFA code required" },
          { status: 401 },
        );
      }
    }

    await prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecret: null },
    });
    return NextResponse.json({ success: true });
  }

  // ---- User disabling their own MFA ----------------------------------------
  if (!password) {
    return NextResponse.json(
      { error: "Password is required to disable MFA" },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.sub } });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { mfaEnabled: false, mfaSecret: null },
  });

  return NextResponse.json({ success: true });
}
