import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function POST() {
  await prisma.$transaction(async (tx) => {
    await tx.trainingTaken.deleteMany({});
    await tx.student.deleteMany({});
    await tx.trainingData.deleteMany({});
    await tx.regionData.deleteMany({});
  });

  return NextResponse.json({ success: true, message: "All data has been wiped." });
}
