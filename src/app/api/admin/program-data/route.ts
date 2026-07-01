import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const data = await prisma.programData.findMany({
    include: {
      specialisation: true,
      trainingData: { select: { fullTitle: true } },
      alternatives: {
        include: { trainingData: { select: { fullTitle: true } } },
      },
    },
    orderBy: [{ programName: "asc" }, { specialisationId: "asc" }, { trainingType: "asc" }],
  });

  const rows = data.map((d: typeof data[number]) => ({
    id: d.id,
    programName: d.programName,
    specialisationId: d.specialisationId,
    specialisationName: d.specialisation.name,
    level: d.level,
    trainingType: d.trainingType ?? null,
    trainingTitle: d.trainingTitle ?? null,
    trainingFullTitle: d.trainingData?.fullTitle ?? "—",
    quantityRequired: d.quantityRequired,
    minimumPerTheatre: d.minimumPerTheatre ?? null,
    alternatives: d.alternatives.map((a: typeof d.alternatives[number]) => ({
      trainingType: a.trainingType,
      trainingTitle: a.trainingTitle,
      trainingFullTitle: a.trainingData?.fullTitle ?? "—",
    })),
  }));

  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const { programName, specialisationId, level, trainingType, trainingTitle, quantityRequired, minimumPerTheatre, alternatives } = body;

  if (!programName?.trim()) {
    return NextResponse.json({ error: "Program name is required" }, { status: 400 });
  }
  if (!specialisationId) {
    return NextResponse.json({ error: "Specialisation is required" }, { status: 400 });
  }
  if (!level || !["Country", "Theatre", "Global"].includes(level)) {
    return NextResponse.json({ error: "Valid level is required" }, { status: 400 });
  }
  // Training required for non-Global, or for Global when trainingTitle is explicitly provided
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

  const spec = await prisma.specialisation.findUnique({ where: { id: specialisationId } });
  if (!spec) {
    return NextResponse.json({ error: "Specialisation not found" }, { status: 404 });
  }

  if (trainingTitle) {
    const training = await prisma.trainingData.findUnique({ where: { trainingTitle } });
    if (!training) {
      return NextResponse.json({ error: "Training not found" }, { status: 404 });
    }
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

  // Ensure the program is registered so it persists (incl. as an admin card).
  await prisma.program.upsert({
    where: { name: programName.trim() },
    create: { name: programName.trim() },
    update: {},
  });

  const record = await prisma.programData.create({
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
  }, { status: 201 });
}
