import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { generateConfigArchive } from "../route";

/**
 * Config-only backup download.
 *
 * Returns an archive of the reference dataset (training catalogue, regions,
 * programs, specialisations, OLX relations, import aliases, system settings)
 * without Student/TrainingTaken — for seeding a fresh installation. Encrypts
 * with the server's ENCRYPTION_KEY when configured (TT01); see the portable
 * sibling endpoint for cross-system, passphrase-encrypted (TT02) archives.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { buffer, filename, contentType } = await generateConfigArchive();

  return new NextResponse(new Blob([new Uint8Array(buffer)]), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
