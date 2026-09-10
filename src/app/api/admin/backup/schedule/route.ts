import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { isEncryptionConfigured } from "@/lib/crypto";
import path from "path";
import fs from "fs";
import {
  type AutoBackupConfig,
  backupConfigPath,
  readAutoBackupConfig,
} from "@/lib/backup-config";
import { backupRoot, resolveWithin } from "@/lib/safe-path";
import { execSync } from "child_process";

const CRON_MARKER = "# training-tracker-auto-backup";

function buildCronExpression(config: AutoBackupConfig): string {
  const [hour, minute] = config.time.split(":").map(Number);
  if (config.frequency === "weekly" && config.dayOfWeek !== undefined) {
    return `${minute} ${hour} * * ${config.dayOfWeek}`;
  }
  return `${minute} ${hour} * * *`;
}

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  // encryptionConfigured is derived, not stored: the UI needs it to explain why
  // the credentials checkboxes are unavailable on an install with no
  // ENCRYPTION_KEY, and this is the request the backup page already makes.
  return NextResponse.json({
    ...readAutoBackupConfig(),
    encryptionConfigured: isEncryptionConfigured(),
  });
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const body = await request.json();

    // Validate time format (HH:MM, 24-hour)
    const time = body.time || "02:00";
    if (!/^\d{1,2}:\d{2}$/.test(time)) {
      return NextResponse.json({ error: "Invalid time format. Use HH:MM." }, { status: 400 });
    }
    const [h, m] = time.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return NextResponse.json({ error: "Invalid time value." }, { status: 400 });
    }

    // Confine the backup directory to the operator-controlled root. The old
    // check hardcoded /opt/training-tracker/ and compared with a plain
    // startsWith, which also accepted sibling paths such as
    // /opt/training-tracker-elsewhere/.
    const root = backupRoot();
    const resolvedPath = resolveWithin(root, body.backupPath || root, { allowBase: true });
    if (!resolvedPath) {
      return NextResponse.json(
        {
          error:
            `Backup path must be inside the backups folder (${root}). ` +
            `Set BACKUP_ROOT in .env to use a different location.`,
        },
        { status: 400 }
      );
    }

    const config: AutoBackupConfig = {
      enabled: !!body.enabled,
      frequency: body.frequency === "weekly" ? "weekly" : "daily",
      time,
      dayOfWeek: body.dayOfWeek !== undefined ? Number(body.dayOfWeek) : 0,
      backupPath: resolvedPath,
      retentionCount: Math.max(1, Number(body.retentionCount) || 5),
      includeCredentials: body.includeCredentials === true,
    };

    // Ensure backup directory exists
    if (!fs.existsSync(config.backupPath)) {
      fs.mkdirSync(config.backupPath, { recursive: true });
    }

    // Save config
    fs.writeFileSync(backupConfigPath(), JSON.stringify(config, null, 2));

    // Update cron. The backup schedule is user-configurable, so unlike the
    // fixed auto-update/auto-export entries this one stays a crontab edit — but
    // it lands in the *service user's* own crontab and needs no privilege.
    const appDir = process.cwd();
    const scriptPath = path.join(appDir, "deploy", "auto-backup.sh");

    // A failure here used to be swallowed. Silently doing nothing is how you
    // end up believing a schedule is active when it never was, so report it.
    let cronWarning: string | undefined;
    try {
      const currentCron = execSync("crontab -l 2>/dev/null || true", {
        encoding: "utf-8",
      });
      const filteredLines = currentCron
        .split("\n")
        .filter((line) => !line.includes(CRON_MARKER) && line.trim() !== "");

      if (config.enabled) {
        const cronExpr = buildCronExpression(config);
        filteredLines.push(
          `${cronExpr} bash ${scriptPath} ${appDir} ${CRON_MARKER}`
        );
      }

      const newCron = filteredLines.join("\n") + "\n";
      execSync("crontab -", { input: newCron, encoding: "utf-8" });
    } catch {
      cronWarning =
        "The schedule was saved, but the cron entry could not be installed. " +
        "Check that cron is installed and that the service user is permitted " +
        "to use it (see /etc/cron.allow). Backups will not run automatically " +
        "until this is resolved.";
    }

    return NextResponse.json({ success: true, config, warning: cronWarning });
  } catch {
    return NextResponse.json(
      { error: "Failed to save schedule" },
      { status: 500 }
    );
  }
}
