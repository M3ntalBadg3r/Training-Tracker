import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isActive, formatDate } from "@/lib/utils";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const fullTitle = searchParams.get("fullTitle");

  if (!fullTitle) {
    return NextResponse.json(
      { error: "fullTitle parameter required" },
      { status: 400 }
    );
  }

  // Find all training titles with this full title
  const trainingDataRecords = await prisma.trainingData.findMany({
    where: { fullTitle },
    select: { trainingTitle: true },
  });

  const trainingTitles = trainingDataRecords.map((td) => td.trainingTitle);

  // Find all training taken records with these titles
  const trainingTaken = await prisma.trainingTaken.findMany({
    where: { trainingTitle: { in: trainingTitles } },
    include: {
      student: {
        include: { regionData: true },
      },
    },
    orderBy: { completedDate: "desc" },
  });

  const result = trainingTaken.map((t) => ({
    fullName: t.student.fullName,
    email: t.student.email,
    theatre: t.student.theatre,
    country: t.student.country,
    active: isActive(t.expiryDate),
    completedDate: formatDate(t.completedDate),
    expiryDate: formatDate(t.expiryDate),
  }));

  return NextResponse.json(result);
}
