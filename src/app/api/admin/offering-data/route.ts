import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, canAccessCompany } from "@/lib/company-scope";
import {
  validateOfferingRequirementBody,
  serializeOfferingDataRow,
  offeringDataInclude,
  type OfferingDataRecord,
} from "@/lib/offering-data-write";

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);

  const data = await prisma.offeringData.findMany({
    where: allowed === null ? {} : { offering: { companyId: { in: allowed } } },
    include: offeringDataInclude,
    orderBy: [{ offeringId: "asc" }, { specialisationId: "asc" }, { trainingType: "asc" }],
  });

  const rows = data.map((d) => serializeOfferingDataRow(d as unknown as OfferingDataRecord));
  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const result = await validateOfferingRequirementBody(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  const v = result.value;

  if (!(await canAccessCompany(auth.sub, auth.role, v.companyId))) {
    return NextResponse.json({ error: "You do not have access to that offering" }, { status: 403 });
  }

  const record = await prisma.$transaction(async (tx) => {
    // Ensure the specialisation is linked to the offering so its section shows.
    await tx.offeringSpecialisation.upsert({
      where: {
        offeringId_specialisationId: {
          offeringId: v.offeringId,
          specialisationId: v.specialisationId,
        },
      },
      create: { offeringId: v.offeringId, specialisationId: v.specialisationId },
      update: {},
    });
    return tx.offeringData.create({
      data: {
        offeringId: v.offeringId,
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
