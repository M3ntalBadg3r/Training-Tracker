import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

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
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
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
