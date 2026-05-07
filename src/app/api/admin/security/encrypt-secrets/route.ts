/**
 * One-shot SuperAdmin endpoint that re-saves any plaintext mfaSecret /
 * ExportCredential.config rows in their encrypted (sealed) form. Idempotent:
 * already-sealed rows are left alone. Run this once after deploying the
 * release that introduced ENCRYPTION_KEY.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import {
  isEncryptionConfigured,
  isEncryptedBlob,
  encryptString,
  isSealedConfig,
  sealConfig,
  openConfig,
} from "@/lib/crypto";

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      { error: "ENCRYPTION_KEY is not configured. Set it in your .env file (openssl rand -hex 32) and restart the app, then retry." },
      { status: 400 },
    );
  }

  // 1) MFA secrets — encrypt any user.mfaSecret that isn't already in
  //    "enc:v1:" form.
  const usersWithSecret = await prisma.user.findMany({
    where: { mfaSecret: { not: null } },
    select: { id: true, mfaSecret: true },
  });
  let mfaSealed = 0;
  for (const u of usersWithSecret) {
    if (!u.mfaSecret) continue;
    if (isEncryptedBlob(u.mfaSecret)) continue;
    await prisma.user.update({
      where: { id: u.id },
      data: { mfaSecret: encryptString(u.mfaSecret) },
    });
    mfaSealed++;
  }

  // 2) Export credentials — re-save any config column that isn't sealed.
  const creds = await prisma.exportCredential.findMany();
  let credSealed = 0;
  let credSkipped = 0;
  for (const c of creds) {
    if (isSealedConfig(c.config)) {
      credSkipped++;
      continue;
    }
    let plain: Record<string, unknown>;
    try {
      plain = openConfig(c.config);
    } catch {
      // Couldn't decrypt and isn't sealed — leave it alone for the admin
      // to re-enter manually rather than risk corrupting it.
      credSkipped++;
      continue;
    }
    const sealed = sealConfig(plain);
    await prisma.exportCredential.update({
      where: { provider: c.provider },
      data: { config: sealed as object },
    });
    credSealed++;
  }

  return NextResponse.json({
    success: true,
    mfaSecretsSealed: mfaSealed,
    mfaSecretsTotal: usersWithSecret.length,
    credentialsSealed: credSealed,
    credentialsSkipped: credSkipped,
    credentialsTotal: creds.length,
  });
}
