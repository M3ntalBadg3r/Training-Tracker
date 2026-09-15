import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { ELIGIBLE_TRAINING_DATA } from "@/lib/reportable-training";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const type = request.nextUrl.searchParams.get("type");
  // Certification/Accreditation/InstructorLedTraining are used by Programs; OLX
  // is additionally offered to the Offerings requirement picker (OLX parents).
  if (!type || !["Certification", "Accreditation", "InstructorLedTraining", "OLX"].includes(type)) {
    return NextResponse.json({ error: "Valid type parameter is required" }, { status: 400 });
  }

  const trainings = await prisma.trainingData.findMany({
    // Reviewed rows only. This feeds the Program/Offering requirement picker,
    // and an unreviewed import would be offered under its placeholder type —
    // which is how one ends up configured into a requirement and counted for
    // real. It reappears here as soon as an admin classifies it.
    where: {
      ...ELIGIBLE_TRAINING_DATA,
      trainingType: type as "Certification" | "Accreditation" | "InstructorLedTraining" | "OLX",
    },
    select: {
      trainingTitle: true,
      fullTitle: true,
    },
    orderBy: [{ fullTitle: "asc" }, { trainingTitle: "asc" }],
  });

  // Multiple trainingTitles can share a fullTitle (common from imports). The
  // requirement picker shows the fullTitle, so collapse to one representative
  // row per fullTitle to avoid visually identical duplicate options. Counting
  // still covers every variant — program compliance groups by fullTitle+type
  // (see getEmailSetsByTitle in lib/program-compliance.ts). The rows are ordered
  // by (fullTitle, trainingTitle), so the representative is deterministic.
  const seen = new Set<string>();
  const deduped = trainings.filter((t) => {
    if (seen.has(t.fullTitle)) return false;
    seen.add(t.fullTitle);
    return true;
  });

  return NextResponse.json(deduped);
}
