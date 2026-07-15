import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { invalidateReportCache } from "@/lib/report-cache";
import {
  validateRequirementBody,
  serializeProgramDataRow,
  programDataInclude,
  type ProgramDataRecord,
} from "@/lib/program-data-write";

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const data = await prisma.programData.findMany({
    include: programDataInclude,
    orderBy: [{ programName: "asc" }, { specialisationId: "asc" }, { trainingType: "asc" }],
  });

  const rows = data.map((d) => serializeProgramDataRow(d as unknown as ProgramDataRecord));
  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const result = await validateRequirementBody(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  const v = result.value;

  // Ensure the program is registered so it persists (incl. as an admin card).
  await prisma.program.upsert({
    where: { name: v.programName },
    create: { name: v.programName },
    update: {},
  });

  const record = await prisma.programData.create({
    data: {
      programName: v.programName,
      specialisationId: v.specialisationId,
      tierId: v.tierId,
      purpose: v.purpose,
      level: v.level as "Country" | "Theatre" | "Global",
      trainingType: v.trainingType as "Certification" | "Accreditation" | "InstructorLedTraining" | null,
      trainingTitle: v.trainingTitle,
      quantityRequired: v.quantityRequired,
      minimumPerTheatre: v.minimumPerTheatre,
      alternatives:
        v.altData.length > 0
          ? {
              create: v.altData.map((a) => ({
                trainingType: a.trainingType as "Certification" | "Accreditation" | "InstructorLedTraining",
                trainingTitle: a.trainingTitle,
              })),
            }
          : undefined,
    },
    include: programDataInclude,
  });

  invalidateReportCache();
  return NextResponse.json(serializeProgramDataRow(record as unknown as ProgramDataRecord), { status: 201 });
}
