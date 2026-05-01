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
  // Theatre handling: only update when the field is present in the body. An
  // explicit empty string means "clear it" (store NULL). Omitting the key
  // leaves the existing value untouched.
  const theatreProvided = Object.prototype.hasOwnProperty.call(body, "theatre");
  const newTheatre = theatreProvided
    ? (typeof body.theatre === "string" && body.theatre.trim()
        ? body.theatre.trim()
        : null)
    : undefined;

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

    // Preserve existing theatre when the body didn't include one.
    const oldRow = await prisma.regionData.findUnique({
      where: { country: decodedCountry },
    });
    const theatreToStore = theatreProvided ? newTheatre : oldRow?.theatre ?? null;

    // Use a transaction: update students to new country, delete old, create new
    const regionData = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await tx.student.updateMany({
        where: { country: decodedCountry },
        data: { country: newCountry },
      });
      await tx.regionData.delete({ where: { country: decodedCountry } });
      return tx.regionData.create({
        data: { country: newCountry, region: newRegion, theatre: theatreToStore },
      });
    });

    return NextResponse.json(regionData);
  }

  const regionData = await prisma.regionData.update({
    where: { country: decodedCountry },
    data: {
      region: newRegion,
      ...(theatreProvided ? { theatre: newTheatre } : {}),
    },
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
