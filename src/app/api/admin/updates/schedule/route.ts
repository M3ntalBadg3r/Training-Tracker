import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import path from "path";
import fs from "fs";

interface ScheduleConfig {
  enabled: boolean;
  frequency: "daily" | "weekly";
  time: string; // HH:MM
  dayOfWeek?: number; // 0=Sunday, 1=Monday, ...6=Saturday
}

const CONFIG_FILENAME = ".auto-update.json";

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
    const time = body.time || "03:00";
    if (!/^\d{1,2}:\d{2}$/.test(time)) {
      return NextResponse.json({ error: "Invalid time format. Use HH:MM." }, { status: 400 });
    }
    const [h, m] = time.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return NextResponse.json({ error: "Invalid time value." }, { status: 400 });
    }

    const config: ScheduleConfig = {
      enabled: !!body.enabled,
      frequency: body.frequency === "weekly" ? "weekly" : "daily",
      time,
      dayOfWeek: body.dayOfWeek !== undefined ? Number(body.dayOfWeek) : 0,
    };

    // Saving the config is the whole job. install.sh installs a fixed root
    // entry in /etc/cron.d/training-tracker that wakes deploy/auto-update.sh
    // every few minutes; that script reads this file and decides whether an
    // update is due. The app therefore never touches root's crontab — it has no
    // privilege to do so, and an app that could rewrite a root cron entry would
    // be an escalation path in its own right.
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));

    return NextResponse.json({ success: true, config });
  } catch {
    return NextResponse.json(
      { error: "Failed to save schedule" },
      { status: 500 }
    );
  }
}
