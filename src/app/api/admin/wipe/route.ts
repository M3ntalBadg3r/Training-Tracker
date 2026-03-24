import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  await prisma.$transaction(async (tx) => {
    await tx.trainingTaken.deleteMany({});
    await tx.student.deleteMany({});
    await tx.trainingData.deleteMany({});
    await tx.regionData.deleteMany({});
  });

  return NextResponse.json({ success: true, message: "All data has been wiped." });
}
