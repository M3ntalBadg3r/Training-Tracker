import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const data = await prisma.programData.findMany({
    include: {
      specialisation: true,
      trainingData: { select: { fullTitle: true } },
    },
    orderBy: [{ programName: "asc" }, { specialisationId: "asc" }, { trainingType: "asc" }],
  });

  const rows = data.map((d) => ({
    id: d.id,
    programName: d.programName,
    specialisationId: d.specialisationId,
    specialisationName: d.specialisation.name,
    level: d.level,
    trainingType: d.trainingType ?? null,
    trainingTitle: d.trainingTitle ?? null,
    trainingFullTitle: d.trainingData?.fullTitle ?? "—",
    quantityRequired: d.quantityRequired,
  }));

  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const { programName, specialisationId, level, trainingType, trainingTitle, quantityRequired } = body;

  if (!programName?.trim()) {
    return NextResponse.json({ error: "Program name is required" }, { status: 400 });
  }
  if (!specialisationId) {
    return NextResponse.json({ error: "Specialisation is required" }, { status: 400 });
  }
  if (!level || !["Country", "Theatre", "Global"].includes(level)) {
    return NextResponse.json({ error: "Valid level is required" }, { status: 400 });
  }
  if (level !== "Global") {
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

  if (level !== "Global" && trainingTitle) {
    const training = await prisma.trainingData.findUnique({ where: { trainingTitle } });
    if (!training) {
      return NextResponse.json({ error: "Training not found" }, { status: 404 });
    }
  }

  const record = await prisma.programData.create({
    data: {
      programName: programName.trim(),
      specialisationId,
      level,
      trainingType: level === "Global" ? null : trainingType,
      trainingTitle: level === "Global" ? null : trainingTitle,
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
    trainingType: record.trainingType ?? null,
    trainingTitle: record.trainingTitle ?? null,
    trainingFullTitle: record.trainingData?.fullTitle ?? "—",
    quantityRequired: record.quantityRequired,
  }, { status: 201 });
}
