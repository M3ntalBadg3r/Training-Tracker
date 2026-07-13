import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import {
  validateOfferingRequirementBody,
  serializeOfferingDataRow,
  offeringDataInclude,
  type OfferingDataRecord,
} from "@/lib/offering-data-write";

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
  const result = await validateOfferingRequirementBody(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  const v = result.value;

  const record = await prisma.$transaction(async (tx) => {
    await tx.offeringSpecialisation.upsert({
      where: {
        offeringName_specialisationId: {
          offeringName: v.offeringName,
          specialisationId: v.specialisationId,
        },
      },
      create: { offeringName: v.offeringName, specialisationId: v.specialisationId },
      update: {},
    });
    await tx.offeringDataAlternative.deleteMany({ where: { offeringDataId: recordId } });
    return tx.offeringData.update({
      where: { id: recordId },
      data: {
        offeringName: v.offeringName,
        specialisationId: v.specialisationId,
        trainingType: v.trainingType as "Certification" | "Accreditation" | "InstructorLedTraining" | "OLX",
        trainingTitle: v.trainingTitle,
        quantityRequired: v.quantityRequired,
        alternatives:
          v.altData.length > 0
            ? {
                create: v.altData.map((a) => ({
                  trainingType: a.trainingType as "Certification" | "Accreditation" | "InstructorLedTraining" | "OLX",
                  trainingTitle: a.trainingTitle,
                })),
              }
            : undefined,
      },
      include: offeringDataInclude,
    });
  });

  return NextResponse.json(serializeOfferingDataRow(record as unknown as OfferingDataRecord));
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

  await prisma.offeringData.delete({ where: { id: recordId } });
  return NextResponse.json({ success: true });
}
