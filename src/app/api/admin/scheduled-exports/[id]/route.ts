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

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const numId = Number(id);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  try {
    const body = await request.json();
    const { name, reportType, format, destination, config, enabled, frequency, time, dayOfWeek, dayOfMonth } = body;

    const record = await prisma.scheduledExport.update({
      where: { id: numId },
      data: {
        ...(name !== undefined && { name }),
        ...(reportType !== undefined && { reportType }),
        ...(format !== undefined && { format }),
        ...(destination !== undefined && { destination }),
        ...(config !== undefined && { config }),
        ...(enabled !== undefined && { enabled }),
        ...(frequency !== undefined && { frequency }),
        ...(time !== undefined && { time }),
        ...(dayOfWeek !== undefined && { dayOfWeek: dayOfWeek === null ? null : Number(dayOfWeek) }),
        ...(dayOfMonth !== undefined && { dayOfMonth: dayOfMonth === null ? null : Number(dayOfMonth) }),
      },
    });

    await syncCron();
    return NextResponse.json(record);
  } catch {
    return NextResponse.json({ error: "Failed to update schedule" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const numId = Number(id);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  try {
    await prisma.scheduledExport.delete({ where: { id: numId } });
    await syncCron();
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete schedule" }, { status: 500 });
  }
}
