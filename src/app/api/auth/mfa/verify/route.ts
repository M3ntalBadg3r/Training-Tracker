import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAuthFromRequest, verifyMfaToken } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// POST: Verify a TOTP code and enable MFA
export async function POST(request: NextRequest) {
  const authUser = await getAuthFromRequest(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: 5 MFA attempts per 15 minutes per user+IP
  const ip = getClientIp(request);
  if (!checkRateLimit(`mfa:${authUser.sub}:${ip}`, 5, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 }
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

  await prisma.user.update({
    where: { id: user.id },
    data: { mfaEnabled: true },
  });

  return NextResponse.json({ success: true });
}
