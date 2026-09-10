import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { loadBackupArchive, restoreFullArchive, requireRestoreStepUp } from "../route";
import path from "path";
import fs from "fs";
import { getBackupPath } from "@/lib/backup-config";

export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const { filename, password, mfaCode } = await request.json();

    // Step-up first: a server-side restore is as destructive as an uploaded one.
    const stepUpError = await requireRestoreStepUp(request, auth.sub, password, mfaCode);
    if (stepUpError) return stepUpError;

    if (!filename) {
      return NextResponse.json({ error: "Filename is required" }, { status: 400 });
    }

    // Prevent path traversal
    const safeName = path.basename(filename);
    if (safeName !== filename || !(safeName.endsWith(".zip") || safeName.endsWith(".zip.enc"))) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    const backupPath = getBackupPath();
    const filePath = path.join(backupPath, safeName);

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "Backup file not found" }, { status: 404 });
    }

    const fileBuffer = fs.readFileSync(filePath);
    let zipBytes: Buffer;
    let archiveWasEncrypted = false;
    try {
      const loaded = await loadBackupArchive(fileBuffer);
      zipBytes = loaded.bytes;
      archiveWasEncrypted = loaded.encrypted;
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to read archive" },
        { status: 400 }
      );
    }
    const zip = await JSZip.loadAsync(zipBytes);

    // Restoring is the *same* operation as an uploaded restore, so it runs the
    // same code. These two used to be independent copies of one transaction and
    // they drifted: the upload path grew a credentials guard this one never
    // got, so any saved backup containing a user aborted the whole restore with
    // an opaque 500. One implementation now — see restoreFullArchive.
    return await restoreFullArchive(zip, request, archiveWasEncrypted);
  } catch (err) {
    console.error("Backup restore failed:", err);
    return NextResponse.json(
      { error: "Restore failed" },
      { status: 500 }
    );
  }
}
