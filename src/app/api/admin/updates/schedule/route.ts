import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

interface ScheduleConfig {
  enabled: boolean;
  frequency: "daily" | "weekly";
  time: string; // HH:MM
  dayOfWeek?: number; // 0=Sunday, 1=Monday, ...6=Saturday
}

const CONFIG_FILENAME = ".auto-update.json";
const CRON_MARKER = "# training-tracker-auto-update";

function getConfigPath(): string {
  return path.join(process.cwd(), CONFIG_FILENAME);
}

function readConfig(): ScheduleConfig {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  return { enabled: false, frequency: "daily", time: "03:00" };
}

function buildCronExpression(config: ScheduleConfig): string {
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
    const config: ScheduleConfig = {
      enabled: !!body.enabled,
      frequency: body.frequency === "weekly" ? "weekly" : "daily",
      time: body.time || "03:00",
      dayOfWeek: body.dayOfWeek !== undefined ? Number(body.dayOfWeek) : 0,
    };

    // Save config
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));

    // Update cron
    const appDir = process.cwd();
    const scriptPath = path.join(appDir, "deploy", "auto-update.sh");

    try {
      // Remove existing cron entry
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
