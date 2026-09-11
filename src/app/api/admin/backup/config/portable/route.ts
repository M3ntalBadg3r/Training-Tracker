import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { encryptBufferWithPassphrase, validatePortablePassphrase } from "@/lib/crypto";
import { readJsonBody } from "@/lib/request-body";
import { generateConfigZip } from "../../route";

/**
 * Portable config-only backup download.
 *
 * Same dataset as GET /api/admin/backup/config, but the archive is encrypted
 * with a key derived from a user-supplied passphrase (envelope magic 'TT02')
 * rather than this install's ENCRYPTION_KEY — so it can be restored on a
 * different system by re-entering the same passphrase.
 */
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  // Same reader as the full portable route: a wrong content-type or malformed
  // body gets its own status instead of being reported as a passphrase problem.
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const passphrase =
    typeof parsed.body?.passphrase === "string" ? parsed.body.passphrase : "";

  const passphraseProblem = validatePortablePassphrase(passphrase);
  if (passphraseProblem) {
    return NextResponse.json({ error: passphraseProblem }, { status: 400 });
  }

  const { buffer, timestamp } = await generateConfigZip();
  const encrypted = encryptBufferWithPassphrase(Buffer.from(buffer), passphrase);
  const filename = `training-tracker-config-${timestamp}.portable.zip.enc`;

  return new NextResponse(new Blob([new Uint8Array(encrypted)]), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
