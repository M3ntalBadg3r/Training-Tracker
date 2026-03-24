import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
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

  const theatres = [...new Set(students.map((s) => s.theatre))].filter(Boolean).sort();
  const countries = [...new Set(students.map((s) => s.country))].filter(Boolean).sort();
  const regionList = regions.map((r) => r.region).filter(Boolean).sort();

  return NextResponse.json({ theatres, regions: regionList, countries });
}
