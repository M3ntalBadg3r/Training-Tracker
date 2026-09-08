import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { loadBackupArchive, restoreFullArchive } from "../route";
import path from "path";
import fs from "fs";

const CONFIG_FILENAME = ".auto-backup.json";

function getBackupPath(): string {
  const configPath = path.join(process.cwd(), CONFIG_FILENAME);
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.backupPath || "/opt/training-tracker/backups";
  }
  return "/opt/training-tracker/backups";
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const { filename } = await request.json();
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
    try {
      zipBytes = await loadBackupArchive(fileBuffer);
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
    return await restoreFullArchive(zip, request);
  } catch (err) {
    console.error("Backup restore failed:", err);
    return NextResponse.json(
      { error: "Restore failed" },
      { status: 500 }
    );
  }
}
