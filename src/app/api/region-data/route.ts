import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { normaliseIsoCode } from "@/lib/iso-countries";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const regions = await prisma.regionData.findMany({
    orderBy: { country: "asc" },
  });

  return NextResponse.json(regions);
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const body = await request.json();
  const { country, region, theatre, isoCode } = body;

  if (!country || !region) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  const trimmedTheatre = typeof theatre === "string" ? theatre.trim() : "";

  // isoCode is input reaching a sink (the DB, and later a geometry lookup), so
  // the shape is enforced here as well as by the DB CHECK. A blank value is the
  // legitimate "unmapped" state and stores NULL; anything present that is not
  // two letters is rejected rather than silently dropped. Case is normalised
  // up rather than refused, so a lowercase spreadsheet value still lands.
  const normalisedIso = normaliseIsoCode(isoCode === undefined ? null : isoCode);
  if (normalisedIso === undefined) {
    return NextResponse.json(
      { error: "ISO code must be two letters (ISO 3166-1 alpha-2)" },
      { status: 400 }
    );
  }

  const regionData = await prisma.regionData.create({
    data: {
      country,
      region,
      theatre: trimmedTheatre ? trimmedTheatre : null,
      isoCode: normalisedIso,
    },
  });

  return NextResponse.json(regionData, { status: 201 });
}
