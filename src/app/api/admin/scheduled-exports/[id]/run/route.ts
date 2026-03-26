import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { runExport } from "@/lib/run-export";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const numId = Number(id);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const schedule = await prisma.scheduledExport.findUnique({ where: { id: numId } });
  if (!schedule) return NextResponse.json({ error: "Schedule not found" }, { status: 404 });

  const result = await runExport(schedule);
  return NextResponse.json(result);
}
