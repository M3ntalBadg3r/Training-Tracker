import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const trainingData = await prisma.trainingData.findMany({
    orderBy: { trainingTitle: "asc" },
  });

  return NextResponse.json(trainingData);
}
