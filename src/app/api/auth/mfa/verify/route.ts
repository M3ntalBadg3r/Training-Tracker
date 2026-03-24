import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAuthFromRequest, verifyMfaToken } from "@/lib/auth";

// POST: Verify a TOTP code and enable MFA
export async function POST(request: NextRequest) {
  const authUser = await getAuthFromRequest(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  await prisma.user.update({
    where: { id: user.id },
    data: { mfaEnabled: true },
  });

  return NextResponse.json({ success: true });
}
