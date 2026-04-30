import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { requireAuth, handleAuthError, requireSuperAdmin } from "@/lib/auth";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ country: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const { country } = await params;
  const decodedCountry = decodeURIComponent(country);
  const body = await request.json();

  const newCountry = body.country?.trim();
  const newRegion = body.region?.trim();

  if (!newRegion) {
    return NextResponse.json({ error: "Region is required" }, { status: 400 });
  }

  // If country name changed, we need to delete + recreate since country is the PK
  if (newCountry && newCountry !== decodedCountry) {
    // Check if the new country name already exists
    const existing = await prisma.regionData.findUnique({
      where: { country: newCountry },
    });
    if (existing) {
      return NextResponse.json(
        { error: `Country "${newCountry}" already exists` },
        { status: 409 }
      );
    }

    // Use a transaction: update students to new country, delete old, create new
    const regionData = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await tx.student.updateMany({
        where: { country: decodedCountry },
        data: { country: newCountry },
      });
      await tx.regionData.delete({ where: { country: decodedCountry } });
      return tx.regionData.create({
        data: { country: newCountry, region: newRegion },
      });
    });

    return NextResponse.json(regionData);
  }

  const regionData = await prisma.regionData.update({
    where: { country: decodedCountry },
    data: { region: newRegion },
  });

  return NextResponse.json(regionData);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ country: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const { country } = await params;
  const decodedCountry = decodeURIComponent(country);

  await prisma.regionData.delete({ where: { country: decodedCountry } });

  return NextResponse.json({ success: true });
}
