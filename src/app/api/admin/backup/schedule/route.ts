import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { isEncryptionConfigured } from "@/lib/crypto";
import fs from "fs";
import {
  type AutoBackupConfig,
  backupConfigPath,
  readAutoBackupConfig,
} from "@/lib/backup-config";
import { backupRoot, resolveWithin } from "@/lib/safe-path";
import { cronJobsInstalled } from "@/lib/update-request";

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
    // Whether anything is actually installed to run the schedule. Reported on
    // the read too, not just after a save, so a reload still tells the truth.
    schedulerInstalled: cronJobsInstalled(),
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

    // Save config. That is the whole job: the schedule is *read* by
    // deploy/auto-backup.sh, which the fixed /etc/cron.d/training-tracker entry
    // runs every five minutes and which decides for itself whether a backup is
    // due — exactly like auto-update.sh.
    //
    // This route used to write the service user's crontab instead, and could
    // not: the unit sets ProtectSystem=strict (spool read-only) and
    // NoNewPrivileges=yes (crontab's setgid bit ignored), so the write failed on
    // every install from v2.70 and automatic backups never ran. The warning it
    // produced blamed /etc/cron.allow, which was never the cause. Do not
    // reintroduce a crontab call here; there is no version of it that works.
    fs.writeFileSync(backupConfigPath(), JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      config,
      schedulerInstalled: cronJobsInstalled(),
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to save schedule" },
      { status: 500 }
    );
  }
}
