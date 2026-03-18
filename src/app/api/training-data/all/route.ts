import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
  const trainingData = await prisma.trainingData.findMany({
    orderBy: { trainingTitle: "asc" },
  });

  return NextResponse.json(trainingData);
}
