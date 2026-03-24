import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getAuthFromRequest,
  generateMfaSecret,
  generateMfaQrCode,
} from "@/lib/auth";

// POST: Generate MFA secret + QR code for the current user
export async function POST(request: NextRequest) {
  const authUser = await getAuthFromRequest(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.sub } });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (user.mfaEnabled) {
    return NextResponse.json(
      { error: "MFA is already enabled" },
      { status: 400 }
    );
  }

  const { secret, uri } = generateMfaSecret(user.username);
  const qrCode = await generateMfaQrCode(uri);

  // Store the secret temporarily (not enabled yet until verified)
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaSecret: secret },
  });

  return NextResponse.json({ qrCode, secret });
}
