import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { verifyCronSignature } from "@/lib/cron-auth";
import { generateBackupArchive } from "../route";
import path from "path";
import fs from "fs";

const CONFIG_FILENAME = ".auto-backup.json";

interface AutoBackupConfig {
  backupPath: string;
  retentionCount: number;
}

function readConfig(): AutoBackupConfig {
  const configPath = path.join(process.cwd(), CONFIG_FILENAME);
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  return { backupPath: "/opt/training-tracker/backups", retentionCount: 5 };
}

function enforceRetention(backupPath: string, retentionCount: number) {
  if (!fs.existsSync(backupPath)) return;

  const files = fs
    .readdirSync(backupPath)
    .filter((f) => f.endsWith(".zip") || f.endsWith(".zip.enc"))
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(backupPath, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  // Delete files exceeding retention count
  for (let i = retentionCount; i < files.length; i++) {
    fs.unlinkSync(path.join(backupPath, files[i].name));
  }
}

export async function POST(request: NextRequest) {
  // Allow cron calls with valid HMAC signature, otherwise require Admin JWT
  const isAutoCron = request.headers.get("x-auto-backup") === "true";
  const cronSignature = request.headers.get("x-cron-signature");
  const isCronAuthed = isAutoCron && verifyCronSignature(cronSignature);

  if (!isCronAuthed) {
    try {
      await requireSuperAdmin(request);
    } catch (error) {
      return handleAuthError(error);
    }
  }

  try {
    const config = readConfig();

    // Ensure directory exists
    if (!fs.existsSync(config.backupPath)) {
      fs.mkdirSync(config.backupPath, { recursive: true });
    }

    // Check writable
    try {
      fs.accessSync(config.backupPath, fs.constants.W_OK);
    } catch {
      return NextResponse.json(
        { error: "Backup directory is not writable" },
        { status: 500 }
      );
    }

    const { buffer, filename } = await generateBackupArchive();
    const filePath = path.join(config.backupPath, filename);

    fs.writeFileSync(filePath, buffer);

    // Enforce retention
    enforceRetention(config.backupPath, config.retentionCount);

    return NextResponse.json({ success: true, filename });
  } catch {
    return NextResponse.json(
      { error: "Failed to save backup" },
      { status: 500 }
    );
  }
}
