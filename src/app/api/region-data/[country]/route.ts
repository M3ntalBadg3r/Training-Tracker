import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ country: string }> }
) {
  const { country } = await params;
  const decodedCountry = decodeURIComponent(country);
  const body = await request.json();

  const regionData = await prisma.regionData.update({
    where: { country: decodedCountry },
    data: { region: body.region },
  });

  return NextResponse.json(regionData);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ country: string }> }
) {
  const { country } = await params;
  const decodedCountry = decodeURIComponent(country);

  await prisma.regionData.delete({ where: { country: decodedCountry } });

  return NextResponse.json({ success: true });
}
