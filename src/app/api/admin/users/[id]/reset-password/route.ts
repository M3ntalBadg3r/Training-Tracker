import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireSuperAdmin,
  handleAuthError,
  hashPassword,
  validatePassword,
  verifyPassword,
  verifyMfaToken,
} from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// POST: Reset another user's password.
//
// Restricted to SuperAdmin (matches the proxy.ts gating for
// /api/admin/users) and additionally requires the calling SuperAdmin to
// re-authenticate with their own password and, if they have MFA enabled,
// a current TOTP code. Without step-up auth, a stolen admin cookie would
// be enough to rotate every account's password.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let auth;
  try {
    auth = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  // Rate limit: 10 password resets per 15 minutes per IP
  const ip = getClientIp(request);
  const limit = await checkRateLimit(`reset-pw:${ip}`, 10, 15 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } }
    );
  }

  const { id } = await params;
  const userId = parseInt(id, 10);
  if (isNaN(userId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const body = await request.json();
  const { password, adminPassword, adminMfaCode } = body as {
    password?: string;
    adminPassword?: string;
    adminMfaCode?: string;
  };

  if (!password) {
    return NextResponse.json(
      { error: "Password is required" },
      { status: 400 }
    );
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  if (!adminPassword) {
    return NextResponse.json(
      { error: "Your current password is required to reset another user's password" },
      { status: 400 }
    );
  }

  const me = await prisma.user.findUnique({ where: { id: auth.sub } });
  if (!me) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const adminPasswordValid = await verifyPassword(adminPassword, me.passwordHash);
  if (!adminPasswordValid) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  if (me.mfaEnabled && me.mfaSecret) {
    if (!adminMfaCode || !verifyMfaToken(me.mfaSecret, adminMfaCode)) {
      return NextResponse.json(
        { error: "MFA code required" },
        { status: 401 }
      );
    }
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });

  return NextResponse.json({ success: true });
}
