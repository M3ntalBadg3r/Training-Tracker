import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { encryptBufferWithPassphrase } from "@/lib/crypto";
import { generateBackupZip } from "../route";

/**
 * Portable backup download.
 *
 * Produces a backup archive encrypted with a key derived from a user-supplied
 * passphrase (envelope magic 'TT02') rather than this install's ENCRYPTION_KEY.
 * Because the key is reproducible from the passphrase alone, the archive can be
 * restored on a *different* system by re-entering the same passphrase — which
 * the install-bound, ENCRYPTION_KEY-based backup cannot do.
 */
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  let passphrase = "";
  try {
    const body = await request.json();
    passphrase = typeof body?.passphrase === "string" ? body.passphrase : "";
  } catch {
    // fall through to validation below
  }

  if (passphrase.length < 8) {
    return NextResponse.json(
      { error: "Passphrase must be at least 8 characters." },
      { status: 400 }
    );
  }

  const { buffer, timestamp } = await generateBackupZip();
  const encrypted = encryptBufferWithPassphrase(Buffer.from(buffer), passphrase);
  const filename = `training-tracker-backup-${timestamp}.portable.zip.enc`;

  return new NextResponse(new Blob([new Uint8Array(encrypted)]), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
