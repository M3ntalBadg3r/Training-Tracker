import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { execSync } from "child_process";
import path from "path";

const CRON_MARKER = "# training-tracker-auto-export";

async function syncCron() {
  try {
    const appDir = process.cwd();
    const scriptPath = path.join(appDir, "deploy", "auto-export.sh");
    const enabledCount = await prisma.scheduledExport.count({ where: { enabled: true } });

    const currentCron = execSync("crontab -l 2>/dev/null || true", { encoding: "utf-8" });
    const filteredLines = currentCron
      .split("\n")
      .filter((line) => !line.includes(CRON_MARKER) && line.trim() !== "");

    if (enabledCount > 0) {
      filteredLines.push(`* * * * * bash ${scriptPath} ${appDir} ${CRON_MARKER}`);
    }

    const newCron = filteredLines.join("\n") + "\n";
    execSync("crontab -", { input: newCron, encoding: "utf-8" });
  } catch {
    // Cron may not be available in all environments
  }
}

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const exports = await prisma.scheduledExport.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(exports);
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const body = await request.json();
    const { name, reportType, format, destination, config, enabled, frequency, time, dayOfWeek, dayOfMonth } = body;

    if (!name || !reportType || !format || !destination || !frequency || !time) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const record = await prisma.scheduledExport.create({
      data: {
        name,
        reportType,
        format,
        destination,
        config: config ?? {},
        enabled: enabled !== false,
        frequency,
        time,
        dayOfWeek: dayOfWeek !== undefined ? Number(dayOfWeek) : null,
        dayOfMonth: dayOfMonth !== undefined ? Number(dayOfMonth) : null,
      },
    });

    await syncCron();
    return NextResponse.json(record, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create schedule" }, { status: 500 });
  }
}
