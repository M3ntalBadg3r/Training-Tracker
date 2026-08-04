import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

interface AutoBackupConfig {
  enabled: boolean;
  frequency: "daily" | "weekly";
  time: string;
  dayOfWeek?: number;
  backupPath: string;
  retentionCount: number;
}

const CONFIG_FILENAME = ".auto-backup.json";
const CRON_MARKER = "# training-tracker-auto-backup";

function getConfigPath(): string {
  return path.join(process.cwd(), CONFIG_FILENAME);
}

function readConfig(): AutoBackupConfig {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  return {
    enabled: false,
    frequency: "daily",
    time: "02:00",
    backupPath: "/opt/training-tracker/backups",
    retentionCount: 5,
  };
}

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

  return NextResponse.json(readConfig());
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

    // Validate backupPath is under an allowed base directory
    const backupPath = body.backupPath || "/opt/training-tracker/backups";
    const resolvedPath = path.resolve(backupPath);
    if (!resolvedPath.startsWith("/opt/training-tracker/")) {
      return NextResponse.json(
        { error: "Backup path must be under /opt/training-tracker/" },
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
    };

    // Ensure backup directory exists
    if (!fs.existsSync(config.backupPath)) {
      fs.mkdirSync(config.backupPath, { recursive: true });
    }

    // Save config
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));

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
