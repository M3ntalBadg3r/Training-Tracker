import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany } from "@/lib/company-scope";
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
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const recordId = parseInt(id, 10);
  if (isNaN(recordId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  // The requirement being edited must belong to an offering the caller can access.
  const existing = await prisma.offeringData.findUnique({
    where: { id: recordId },
    include: { offering: { select: { companyId: true } } },
  });
  if (!existing) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }
  if (!(await canAccessCompany(auth.sub, auth.role, existing.offering.companyId))) {
    return NextResponse.json({ error: "You do not have access to that offering" }, { status: 403 });
  }

  const body = await request.json();
  const result = await validateOfferingRequirementBody(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  const v = result.value;

  // The (possibly re-pointed) target offering must also be accessible.
  if (!(await canAccessCompany(auth.sub, auth.role, v.companyId))) {
    return NextResponse.json({ error: "You do not have access to that offering" }, { status: 403 });
  }

  const record = await prisma.$transaction(async (tx) => {
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
    await tx.offeringDataAlternative.deleteMany({ where: { offeringDataId: recordId } });
    return tx.offeringData.update({
      where: { id: recordId },
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

  return NextResponse.json(serializeOfferingDataRow(record as unknown as OfferingDataRecord));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const recordId = parseInt(id, 10);
  if (isNaN(recordId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const existing = await prisma.offeringData.findUnique({
    where: { id: recordId },
    include: { offering: { select: { companyId: true } } },
  });
  if (!existing) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }
  if (!(await canAccessCompany(auth.sub, auth.role, existing.offering.companyId))) {
    return NextResponse.json({ error: "You do not have access to that offering" }, { status: 403 });
  }

  await prisma.offeringData.delete({ where: { id: recordId } });
  return NextResponse.json({ success: true });
}
