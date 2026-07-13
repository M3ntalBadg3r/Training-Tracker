import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import {
  validateOfferingRequirementBody,
  serializeOfferingDataRow,
  offeringDataInclude,
  type OfferingDataRecord,
} from "@/lib/offering-data-write";

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const data = await prisma.offeringData.findMany({
    include: offeringDataInclude,
    orderBy: [{ offeringName: "asc" }, { specialisationId: "asc" }, { trainingType: "asc" }],
  });

  const rows = data.map((d) => serializeOfferingDataRow(d as unknown as OfferingDataRecord));
  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const result = await validateOfferingRequirementBody(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  const v = result.value;

  const record = await prisma.$transaction(async (tx) => {
    // Ensure the specialisation is linked to the offering so its section shows.
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
    return tx.offeringData.create({
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

  return NextResponse.json(serializeOfferingDataRow(record as unknown as OfferingDataRecord), { status: 201 });
}
