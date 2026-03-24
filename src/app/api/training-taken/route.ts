import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { TrainingType } from "@prisma/client";
import { isActive, formatDate } from "@/lib/utils";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const fullTitle = searchParams.get("fullTitle");
  const trainingType = searchParams.get("trainingType");

  if (!fullTitle) {
    return NextResponse.json(
      { error: "fullTitle parameter required" },
      { status: 400 }
    );
  }

  // Find all training titles with this full title (and optionally trainingType)
  const where: { fullTitle: string; trainingType?: TrainingType } = { fullTitle };
  if (trainingType && Object.values(TrainingType).includes(trainingType as TrainingType)) {
    where.trainingType = trainingType as TrainingType;
  }

  const trainingDataRecords = await prisma.trainingData.findMany({
    where,
    select: { trainingTitle: true },
  });

  const trainingTitles = trainingDataRecords.map((td) => td.trainingTitle);

  // Optional location filters
  const theatre = searchParams.get("theatre");
  const region = searchParams.get("region");
  const country = searchParams.get("country");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const studentWhere: Record<string, any> = {};
  if (theatre) studentWhere.theatre = theatre;
  if (country) studentWhere.country = country;
  if (region) studentWhere.regionData = { region };

  // Find all training taken records with these titles
  const trainingTaken = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: trainingTitles },
      ...(Object.keys(studentWhere).length > 0 ? { student: studentWhere } : {}),
    },
    include: {
      student: {
        include: { regionData: true },
      },
    },
    orderBy: { completedDate: "desc" },
  });

  // Deduplicate by student email, keeping the most recent record
  const byStudent = new Map<string, (typeof trainingTaken)[number]>();
  for (const t of trainingTaken) {
    const existing = byStudent.get(t.email);
    if (!existing || t.completedDate > existing.completedDate) {
      byStudent.set(t.email, t);
    }
  }

  const result = Array.from(byStudent.values()).map((t) => ({
    fullName: t.student.fullName,
    email: t.student.email,
    theatre: t.student.theatre,
    region: t.student.regionData?.region ?? "",
    country: t.student.country,
    active: isActive(t.expiryDate),
    completedDate: formatDate(t.completedDate),
    expiryDate: formatDate(t.expiryDate),
  }));

  return NextResponse.json(result);
}
