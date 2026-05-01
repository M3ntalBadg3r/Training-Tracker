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
    include: {
      subItemMemberships: { select: { subItemTrainingTitle: true } },
      parentMemberships: { select: { parentTrainingTitle: true } },
    },
  });

  const result = trainingData.map((t) => ({
    trainingTitle: t.trainingTitle,
    fullTitle: t.fullTitle,
    trainingType: t.trainingType,
    productType: t.productType,
    function: t.function,
    link: t.link,
    certification: t.certification,
    isIncomplete: t.isIncomplete,
    subItems: t.subItemMemberships.map((m) => m.subItemTrainingTitle),
    parents: t.parentMemberships.map((m) => m.parentTrainingTitle),
  }));

  return NextResponse.json(result);
}
