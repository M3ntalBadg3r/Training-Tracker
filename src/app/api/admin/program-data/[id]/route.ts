import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const recordId = parseInt(id, 10);
  if (isNaN(recordId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const body = await request.json();
  const { programName, specialisationId, level, trainingType, trainingTitle, quantityRequired } = body;

  if (!programName?.trim()) {
    return NextResponse.json({ error: "Program name is required" }, { status: 400 });
  }
  if (!level || !["Country", "Theatre", "Global"].includes(level)) {
    return NextResponse.json({ error: "Valid level is required" }, { status: 400 });
  }
  if (!trainingType || !["Certification", "Accreditation", "InstructorLedTraining"].includes(trainingType)) {
    return NextResponse.json({ error: "Valid training type is required" }, { status: 400 });
  }
  if (!trainingTitle?.trim()) {
    return NextResponse.json({ error: "Training is required" }, { status: 400 });
  }
  if (!quantityRequired || quantityRequired < 1) {
    return NextResponse.json({ error: "Quantity must be at least 1" }, { status: 400 });
  }

  const record = await prisma.programData.update({
    where: { id: recordId },
    data: {
      programName: programName.trim(),
      specialisationId,
      level,
      trainingType,
      trainingTitle,
      quantityRequired,
    },
    include: {
      specialisation: true,
      trainingData: { select: { fullTitle: true } },
    },
  });

  return NextResponse.json({
    id: record.id,
    programName: record.programName,
    specialisationId: record.specialisationId,
    specialisationName: record.specialisation.name,
    level: record.level,
    trainingType: record.trainingType,
    trainingTitle: record.trainingTitle,
    trainingFullTitle: record.trainingData.fullTitle,
    quantityRequired: record.quantityRequired,
  });
}

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
  const recordId = parseInt(id, 10);
  if (isNaN(recordId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  await prisma.programData.delete({ where: { id: recordId } });
  return NextResponse.json({ success: true });
}
