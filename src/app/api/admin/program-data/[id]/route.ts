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

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const recordId = parseInt(id, 10);
  if (isNaN(recordId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const body = await request.json();
  const result = await validateRequirementBody(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  const v = result.value;

  // Use a transaction to update the record and replace alternatives.
  const record = await prisma.$transaction(async (tx) => {
    await tx.programDataAlternative.deleteMany({ where: { programDataId: recordId } });
    return tx.programData.update({
      where: { id: recordId },
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
  });

  invalidateReportCache();
  return NextResponse.json(serializeProgramDataRow(record as unknown as ProgramDataRecord));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const recordId = parseInt(id, 10);
  if (isNaN(recordId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  await prisma.programData.delete({ where: { id: recordId } });
  invalidateReportCache();
  return NextResponse.json({ success: true });
}
