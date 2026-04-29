import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { parseDate, computeExpiryDate } from "@/lib/utils";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const { id } = await params;
  const numId = parseInt(id, 10);

  if (isNaN(numId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  await prisma.trainingTaken.delete({ where: { id: numId } });

  return NextResponse.json({ success: true });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const { id } = await params;
  const numId = parseInt(id, 10);

  if (isNaN(numId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const body = await request.json();
  const { completedDate } = body;

  if (!completedDate || typeof completedDate !== "string") {
    return NextResponse.json(
      { error: "completedDate is required" },
      { status: 400 }
    );
  }

  const parsedCompleted = parseDate(completedDate);
  if (!parsedCompleted) {
    return NextResponse.json(
      { error: "Invalid completedDate" },
      { status: 400 }
    );
  }

  const updated = await prisma.trainingTaken.update({
    where: { id: numId },
    data: {
      completedDate: parsedCompleted,
      expiryDate: computeExpiryDate(parsedCompleted),
    },
  });

  return NextResponse.json(updated);
}
