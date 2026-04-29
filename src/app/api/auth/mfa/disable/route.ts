import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAuthFromRequest, verifyPassword } from "@/lib/auth";

// POST: Disable MFA for current user (requires password) or for another user (admin only)
export async function POST(request: NextRequest) {
  const authUser = await getAuthFromRequest(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { userId, password } = body;

  // SuperAdmin disabling MFA for another user
  if (userId && userId !== authUser.sub) {
    if (authUser.role !== "SuperAdmin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    await prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecret: null },
    });
    return NextResponse.json({ success: true });
  }

  // User disabling their own MFA — requires password
  if (!password) {
    return NextResponse.json(
      { error: "Password is required to disable MFA" },
      { status: 400 }
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
