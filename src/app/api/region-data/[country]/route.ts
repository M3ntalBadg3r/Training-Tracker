import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { safeDecodeParam } from "@/lib/utils";
import { normaliseIsoCode } from "@/lib/iso-countries";

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
  const decodedCountry = safeDecodeParam(country);
  if (decodedCountry === null) {
    return NextResponse.json({ error: "Invalid country parameter" }, { status: 400 });
  }
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

  // isoCode follows the same rule as theatre: only touched when the key is
  // present. An explicit empty string means "clear it" (store NULL, the
  // first-class "unmapped" state); omitting the key leaves the stored value
  // alone. Shape is enforced here as well as by the DB CHECK because this is
  // input reaching a sink, and case is normalised up rather than refused.
  const isoProvided = Object.prototype.hasOwnProperty.call(body, "isoCode");
  const newIsoCode = isoProvided ? normaliseIsoCode(body.isoCode) : undefined;

  if (!newRegion) {
    return NextResponse.json({ error: "Region is required" }, { status: 400 });
  }
  if (isoProvided && newIsoCode === undefined) {
    return NextResponse.json(
      { error: "ISO code must be two letters (ISO 3166-1 alpha-2)" },
      { status: 400 }
    );
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

    // Preserve the existing theatre / ISO code when the body didn't include one.
    const oldRow = await prisma.regionData.findUnique({
      where: { country: decodedCountry },
    });
    const theatreToStore = theatreProvided ? newTheatre : oldRow?.theatre ?? null;
    const isoToStore = isoProvided ? newIsoCode ?? null : oldRow?.isoCode ?? null;

    // Use a transaction: update students to new country, delete old, create new
    const regionData = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await tx.student.updateMany({
        where: { country: decodedCountry },
        data: { country: newCountry },
      });
      await tx.regionData.delete({ where: { country: decodedCountry } });
      return tx.regionData.create({
        data: {
          country: newCountry,
          region: newRegion,
          theatre: theatreToStore,
          isoCode: isoToStore,
        },
      });
    });

    return NextResponse.json(regionData);
  }

  const regionData = await prisma.regionData.update({
    where: { country: decodedCountry },
    data: {
      region: newRegion,
      ...(theatreProvided ? { theatre: newTheatre } : {}),
      ...(isoProvided ? { isoCode: newIsoCode ?? null } : {}),
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
  const decodedCountry = safeDecodeParam(country);
  if (decodedCountry === null) {
    return NextResponse.json({ error: "Invalid country parameter" }, { status: 400 });
  }

  await prisma.regionData.delete({ where: { country: decodedCountry } });

  return NextResponse.json({ success: true });
}
