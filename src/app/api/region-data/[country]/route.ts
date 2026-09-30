import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { safeDecodeParam } from "@/lib/utils";
import { normaliseIsoCode } from "@/lib/iso-countries";
import { invalidateReportCache } from "@/lib/report-cache";

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
  let body: Record<string, unknown>;
  try {
    const raw: unknown = await request.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // A wrong type used to reach `.trim()` and surface as a 500.
  if (body.country !== undefined && body.country !== null && typeof body.country !== "string") {
    return NextResponse.json({ error: "Country must be text" }, { status: 400 });
  }
  const newCountry = typeof body.country === "string" ? body.country.trim() : undefined;
  // Region follows the same present/absent rule as theatre and isoCode below:
  // omitting the key leaves the stored value alone, and an explicit blank is
  // the first-class "no region defined" state rather than an error. It stores
  // as "" rather than NULL only because the column is NOT NULL.
  const regionProvided = Object.prototype.hasOwnProperty.call(body, "region");
  const newRegion = regionProvided
    ? (typeof body.region === "string" ? body.region.trim() : "")
    : undefined;
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

  if (isoProvided && newIsoCode === undefined) {
    return NextResponse.json(
      { error: "ISO code must be two letters (ISO 3166-1 alpha-2)" },
      { status: 400 }
    );
  }

  // A rename is a plain primary-key UPDATE, never a delete + recreate. Every
  // FK onto region_data.country (students, country_set_members) is ON UPDATE
  // CASCADE, so one statement carries them all atomically. The old
  // delete+recreate re-pointed students at the new name before that row
  // existed (an FK violation whenever the country had students), and deleting
  // the row would have cascaded away its Country Set memberships.
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

    const oldRow = await prisma.regionData.findUnique({
      where: { country: decodedCountry },
      select: { country: true },
    });
    if (!oldRow) {
      return NextResponse.json({ error: "Country not found" }, { status: 404 });
    }

    try {
      const regionData = await prisma.$transaction(async (tx: PrismaTransactionClient) =>
        tx.regionData.update({
          where: { country: decodedCountry },
          // Region / theatre / ISO code are left alone unless the body carried
          // them — the same present/absent rule as the non-rename path below.
          data: {
            country: newCountry,
            ...(regionProvided ? { region: newRegion ?? "" } : {}),
            ...(theatreProvided ? { theatre: newTheatre } : {}),
            ...(isoProvided ? { isoCode: newIsoCode ?? null } : {}),
          },
        })
      );
      // Students and Country Set memberships now carry the new name, so any
      // cached report/plan keyed on the old one is stale.
      invalidateReportCache();
      return NextResponse.json(regionData);
    } catch (err) {
      // A concurrent create of the same name between the check and the write.
      if ((err as { code?: unknown })?.code === "P2002") {
        return NextResponse.json(
          { error: `Country "${newCountry}" already exists` },
          { status: 409 }
        );
      }
      console.warn("region-data rename failed", err);
      return NextResponse.json({ error: "Could not rename the country" }, { status: 500 });
    }
  }

  const regionData = await prisma.regionData.update({
    where: { country: decodedCountry },
    data: {
      ...(regionProvided ? { region: newRegion ?? "" } : {}),
      ...(theatreProvided ? { theatre: newTheatre } : {}),
      ...(isoProvided ? { isoCode: newIsoCode ?? null } : {}),
    },
  });

  // Region / theatre changes move countries between Region-level (and
  // theatre-scoped) compliance populations, so cached results are stale.
  invalidateReportCache();
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

  try {
    await prisma.regionData.delete({ where: { country: decodedCountry } });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    // students.country is ON DELETE RESTRICT: a country still in use cannot go.
    if (code === "P2003") {
      return NextResponse.json({ error: "Country is still assigned to students" }, { status: 409 });
    }
    if (code === "P2025") {
      return NextResponse.json({ error: "Country not found" }, { status: 404 });
    }
    console.warn("region-data delete failed", err);
    return NextResponse.json({ error: "Could not delete the country" }, { status: 500 });
  }

  // The delete cascades the country out of every Country Set.
  invalidateReportCache();
  return NextResponse.json({ success: true });
}
