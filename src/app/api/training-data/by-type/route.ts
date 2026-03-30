import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const type = request.nextUrl.searchParams.get("type");
  if (!type || !["Certification", "Accreditation", "InstructorLedTraining"].includes(type)) {
    return NextResponse.json({ error: "Valid type parameter is required" }, { status: 400 });
  }

  const trainings = await prisma.trainingData.findMany({
    where: { trainingType: type as "Certification" | "Accreditation" | "InstructorLedTraining" },
    select: {
      trainingTitle: true,
      fullTitle: true,
    },
    orderBy: { fullTitle: "asc" },
  });

  return NextResponse.json(trainings);
}
