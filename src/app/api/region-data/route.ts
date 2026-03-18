import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
  const regions = await prisma.regionData.findMany({
    orderBy: { country: "asc" },
  });

  return NextResponse.json(regions);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { country, region } = body;

  if (!country || !region) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  const regionData = await prisma.regionData.create({
    data: { country, region },
  });

  return NextResponse.json(regionData, { status: 201 });
}
