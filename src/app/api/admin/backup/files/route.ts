import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
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

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const backupPath = getBackupPath();

    if (!fs.existsSync(backupPath)) {
      return NextResponse.json({ files: [], backupPath });
    }

    const entries = fs.readdirSync(backupPath, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".zip"))
      .map((e) => {
        const filePath = path.join(backupPath, e.name);
        const stats = fs.statSync(filePath);
        return {
          name: e.name,
          size: stats.size,
          created: stats.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

    return NextResponse.json({ files, backupPath });
  } catch {
    return NextResponse.json({ files: [], backupPath: "", error: "Failed to list backup files" });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
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
    if (safeName !== filename || !safeName.endsWith(".zip")) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    const backupPath = getBackupPath();
    const filePath = path.join(backupPath, safeName);

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    fs.unlinkSync(filePath);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete file" }, { status: 500 });
  }
}
