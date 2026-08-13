import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getAuthFromRequest,
  generateMfaSecret,
  generateMfaQrCode,
  sealMfaSecret,
} from "@/lib/auth";
import { getBrandingSafe } from "@/lib/system-settings";

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

  // Brand the authenticator-app entry so a white-labelled install doesn't show
  // the stock product name in the user's authenticator.
  const { appName } = await getBrandingSafe();
  const { secret, uri } = generateMfaSecret(user.username, appName);
  const qrCode = await generateMfaQrCode(uri);

  // Store the secret temporarily (not enabled yet until verified). The
  // returned `secret` is the base32 string the authenticator app needs to
  // see; what we persist is the encrypted form.
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaSecret: sealMfaSecret(secret) },
  });

  return NextResponse.json({ qrCode, secret });
}
