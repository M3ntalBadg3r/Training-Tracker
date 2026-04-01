import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { runExport } from "@/lib/run-export";
import { verifyCronSignature } from "@/lib/cron-auth";

function isDue(schedule: {
  frequency: string;
  time: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  lastRunAt: Date | null;
}): boolean {
  const now = new Date();
  const [schedHour, schedMin] = schedule.time.split(":").map(Number);

  // Schedule times are stored as UTC — compare using UTC methods
  if (now.getUTCHours() !== schedHour || now.getUTCMinutes() !== schedMin) return false;

  // Check frequency / day constraints (UTC)
  if (schedule.frequency === "weekly" && schedule.dayOfWeek !== null) {
    if (now.getUTCDay() !== schedule.dayOfWeek) return false;
  }
  if (schedule.frequency === "monthly" && schedule.dayOfMonth !== null) {
    if (now.getUTCDate() !== schedule.dayOfMonth) return false;
  }

  // Avoid re-running if already ran in this minute
  if (schedule.lastRunAt) {
    const diff = now.getTime() - schedule.lastRunAt.getTime();
    if (diff < 60_000) return false;
  }

  return true;
}

export async function POST(request: NextRequest) {
  // This endpoint is called by the cron script. Verify HMAC signature.
  const xHeader = request.headers.get("x-auto-export");
  const cronSignature = request.headers.get("x-cron-signature");
  if (xHeader !== "true" || !verifyCronSignature(cronSignature)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const schedules = await prisma.scheduledExport.findMany({ where: { enabled: true } });
  const due = schedules.filter(isDue);

  const results: { id: number; name: string; status: string; error?: string }[] = [];

  for (const schedule of due) {
    const result = await runExport(schedule);
    results.push({ id: schedule.id, name: schedule.name, ...result });
  }

  return NextResponse.json({ ran: results.length, results });
}
