import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { encryptBufferWithPassphrase, validatePortablePassphrase } from "@/lib/crypto";
import { readJsonBody } from "@/lib/request-body";
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

  // A bare `request.json()` in a try/catch swallowed a wrong content-type and a
  // malformed body alike, then reported both as a passphrase problem. The shared
  // reader distinguishes them (415 / 413 / 400) the way every other body-taking
  // route here does.
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const passphrase = typeof body?.passphrase === "string" ? body.passphrase : "";
  const includeCredentials = body?.includeCredentials === true;

  const passphraseProblem = validatePortablePassphrase(passphrase);
  if (passphraseProblem) {
    return NextResponse.json({ error: passphraseProblem }, { status: 400 });
  }

  // A portable archive is passphrase-encrypted by construction, so unlike the
  // ENCRYPTION_KEY-based path there is no case where credentials would land in
  // a plaintext zip — the opt-in is honoured as given.
  const { buffer, timestamp } = await generateBackupZip({ includeCredentials });
  const encrypted = encryptBufferWithPassphrase(Buffer.from(buffer), passphrase);
  const filename = `training-tracker-backup-${timestamp}.portable.zip.enc`;

  return new NextResponse(new Blob([new Uint8Array(encrypted)]), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
