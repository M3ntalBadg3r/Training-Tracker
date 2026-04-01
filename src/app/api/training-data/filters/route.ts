import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const [students, regions] = await Promise.all([
    prisma.student.findMany({
      select: { theatre: true, country: true },
      distinct: ["theatre", "country"],
    }),
    prisma.regionData.findMany({
      select: { region: true },
      distinct: ["region"],
    }),
  ]);

  const theatres = [...new Set(students.map((s: typeof students[number]) => s.theatre))].filter(Boolean).sort();
  const countries = [...new Set(students.map((s: typeof students[number]) => s.country))].filter(Boolean).sort();
  const regionList = regions.map((r: typeof regions[number]) => r.region).filter(Boolean).sort();

  return NextResponse.json({ theatres, regions: regionList, countries });
}
