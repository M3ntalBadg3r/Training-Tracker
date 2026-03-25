import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
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
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  return NextResponse.json(readConfig());
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const body = await request.json();
    const config: AutoBackupConfig = {
      enabled: !!body.enabled,
      frequency: body.frequency === "weekly" ? "weekly" : "daily",
      time: body.time || "02:00",
      dayOfWeek: body.dayOfWeek !== undefined ? Number(body.dayOfWeek) : 0,
      backupPath: body.backupPath || "/opt/training-tracker/backups",
      retentionCount: Math.max(1, Number(body.retentionCount) || 5),
    };

    // Ensure backup directory exists
    if (!fs.existsSync(config.backupPath)) {
      fs.mkdirSync(config.backupPath, { recursive: true });
    }

    // Save config
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));

    // Update cron
    const appDir = process.cwd();
    const scriptPath = path.join(appDir, "deploy", "auto-backup.sh");

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
      execSync(`echo "${newCron}" | crontab -`, { encoding: "utf-8" });
    } catch {
      // Cron may not be available in all environments
    }

    return NextResponse.json({ success: true, config });
  } catch {
    return NextResponse.json(
      { error: "Failed to save schedule" },
      { status: 500 }
    );
  }
}
