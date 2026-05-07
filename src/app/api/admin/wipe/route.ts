import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    await tx.trainingTaken.deleteMany({});
    await tx.student.deleteMany({});
    await tx.programData.deleteMany({});
    await tx.specialisation.deleteMany({});
    await tx.trainingData.deleteMany({});
    await tx.regionData.deleteMany({});
  });

  return NextResponse.json({ success: true, message: "All data has been wiped." });
}
