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
      productType: { select: { name: true } },
      subItemMemberships: { select: { subItemTrainingTitle: true } },
      parentMemberships: { select: { parentTrainingTitle: true } },
    },
  });

  // How many people each excluded entry is holding back from reporting.
  //
  // An entry awaiting review, or one an admin has ignored, contributes nothing
  // to reports (see lib/reportable-training.ts) — but its completions are real
  // people. The admin deciding what to do with the entry needs to see what that
  // exclusion costs, so count the distinct learners behind it.
  //
  // Scoped to the excluded titles rather than the whole table: those are the
  // only rows that can display a count, and there are typically a handful.
  const excludedTitles = trainingData
    .filter((t) => t.isIncomplete || t.isIgnored)
    .map((t) => t.trainingTitle);

  const excludedPeople = new Map<string, number>();
  if (excludedTitles.length > 0) {
    // distinct on (trainingTitle, email) so one learner with several completions
    // of the same training counts once.
    const rows = await prisma.trainingTaken.findMany({
      where: { trainingTitle: { in: excludedTitles } },
      select: { trainingTitle: true, email: true },
      distinct: ["trainingTitle", "email"],
    });
    for (const r of rows) {
      excludedPeople.set(r.trainingTitle, (excludedPeople.get(r.trainingTitle) ?? 0) + 1);
    }
  }

  const result = trainingData.map((t) => ({
    trainingTitle: t.trainingTitle,
    fullTitle: t.fullTitle,
    trainingType: t.trainingType,
    productType: t.productType.name,
    function: t.function,
    link: t.link,
    certification: t.certification,
    isLegacy: t.isLegacy,
    replacedBy: t.replacedBy,
    isIncomplete: t.isIncomplete,
    isIgnored: t.isIgnored,
    // Present (and meaningful) only on rows excluded from reporting; 0 elsewhere.
    excludedPeople: excludedPeople.get(t.trainingTitle) ?? 0,
    subItems: t.subItemMemberships.map((m) => m.subItemTrainingTitle),
    parents: t.parentMemberships.map((m) => m.parentTrainingTitle),
  }));

  return NextResponse.json(result);
}
