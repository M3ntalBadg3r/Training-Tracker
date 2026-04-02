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
  const { programName, specialisationId, level, trainingType, trainingTitle, quantityRequired, minimumPerTheatre, alternatives } = body;

  if (!programName?.trim()) {
    return NextResponse.json({ error: "Program name is required" }, { status: 400 });
  }
  if (!level || !["Country", "Theatre", "Global"].includes(level)) {
    return NextResponse.json({ error: "Valid level is required" }, { status: 400 });
  }
  const hasTraining = trainingTitle != null && trainingTitle !== "";
  if (level !== "Global" || hasTraining) {
    if (!trainingType || !["Certification", "Accreditation", "InstructorLedTraining"].includes(trainingType)) {
      return NextResponse.json({ error: "Valid training type is required" }, { status: 400 });
    }
    if (!trainingTitle?.trim()) {
      return NextResponse.json({ error: "Training is required" }, { status: 400 });
    }
  }
  if (!quantityRequired || quantityRequired < 1) {
    return NextResponse.json({ error: "Quantity must be at least 1" }, { status: 400 });
  }

  // Validate alternatives
  const altData: { trainingType: string; trainingTitle: string }[] = [];
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    for (const alt of alternatives) {
      if (!alt.trainingType || !["Certification", "Accreditation", "InstructorLedTraining"].includes(alt.trainingType)) {
        return NextResponse.json({ error: "Each alternative must have a valid training type" }, { status: 400 });
      }
      if (!alt.trainingTitle?.trim()) {
        return NextResponse.json({ error: "Each alternative must have a training selected" }, { status: 400 });
      }
      const altTraining = await prisma.trainingData.findUnique({ where: { trainingTitle: alt.trainingTitle } });
      if (!altTraining) {
        return NextResponse.json({ error: `Alternative training "${alt.trainingTitle}" not found` }, { status: 404 });
      }
      altData.push({ trainingType: alt.trainingType, trainingTitle: alt.trainingTitle });
    }
  }

  // Use a transaction to update the record and replace alternatives
  const record = await prisma.$transaction(async (tx) => {
    // Delete existing alternatives
    await tx.programDataAlternative.deleteMany({ where: { programDataId: recordId } });

    // Update the record and create new alternatives
    return tx.programData.update({
      where: { id: recordId },
      data: {
        programName: programName.trim(),
        specialisationId,
        level,
        trainingType: hasTraining ? trainingType : null,
        trainingTitle: hasTraining ? trainingTitle : null,
        quantityRequired,
        minimumPerTheatre: minimumPerTheatre ?? null,
        alternatives: altData.length > 0 ? {
          create: altData.map((a) => ({
            trainingType: a.trainingType as "Certification" | "Accreditation" | "InstructorLedTraining",
            trainingTitle: a.trainingTitle,
          })),
        } : undefined,
      },
      include: {
        specialisation: true,
        trainingData: { select: { fullTitle: true } },
        alternatives: {
          include: { trainingData: { select: { fullTitle: true } } },
        },
      },
    });
  });

  return NextResponse.json({
    id: record.id,
    programName: record.programName,
    specialisationId: record.specialisationId,
    specialisationName: record.specialisation.name,
    level: record.level,
    trainingType: record.trainingType ?? null,
    trainingTitle: record.trainingTitle ?? null,
    trainingFullTitle: record.trainingData?.fullTitle ?? "—",
    quantityRequired: record.quantityRequired,
    minimumPerTheatre: record.minimumPerTheatre ?? null,
    alternatives: record.alternatives.map((a: typeof record.alternatives[number]) => ({
      trainingType: a.trainingType,
      trainingTitle: a.trainingTitle,
      trainingFullTitle: a.trainingData?.fullTitle ?? "—",
    })),
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
