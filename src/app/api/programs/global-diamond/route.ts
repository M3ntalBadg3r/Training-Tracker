import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import {
  extractTitles,
  getEmailSetsByTitle,
  getEmailSetsByTitleAndTheatre,
  listTheatres,
  unionAttained,
  unionAttainedByTheatre,
} from "@/lib/program-compliance";

const GLOBAL_DIAMOND_PROGRAM_NAME = "Global Diamond";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const programData = await prisma.programData.findMany({
    where: { programName: GLOBAL_DIAMOND_PROGRAM_NAME },
    include: {
      specialisation: true,
      trainingData: { select: { fullTitle: true } },
      alternatives: {
        include: { trainingData: { select: { fullTitle: true } } },
      },
    },
    orderBy: [{ specialisationId: "asc" }, { trainingType: "asc" }],
  });

  if (programData.length === 0) {
    return NextResponse.json({ specialisations: [] });
  }

  const now = new Date();
  const theatres = await listTheatres();

  const allTitles = extractTitles(programData);
  const emailSets = await getEmailSetsByTitle(allTitles, now);
  const byTitleAndTheatre = await getEmailSetsByTitleAndTheatre(allTitles, now);

  const specMap = new Map<string, typeof programData>();
  for (const pd of programData) {
    const key = pd.specialisation.name;
    if (!specMap.has(key)) specMap.set(key, []);
    specMap.get(key)!.push(pd);
  }

  const specialisations = [];
  for (const [specName, reqs] of specMap) {
    const requirements = reqs.map((req: typeof programData[number]) => {
      const globalAttained = unionAttained(req, emailSets);
      const minimumPerTheatre = req.minimumPerTheatre ?? null;

      let theatreBreakdown: { theatre: string; count: number; compliant: boolean }[] | null = null;
      if (minimumPerTheatre !== null && minimumPerTheatre > 0) {
        theatreBreakdown = unionAttainedByTheatre(req, byTitleAndTheatre, theatres).map((t) => ({
          theatre: t.theatre,
          count: t.count,
          compliant: t.count >= minimumPerTheatre,
        }));
      }

      const globalMet = globalAttained >= req.quantityRequired;
      const theatresMet =
        theatreBreakdown === null || theatreBreakdown.every((t) => t.compliant);
      const compliant = globalMet && theatresMet;

      return {
        trainingType: req.trainingType ?? null,
        trainingTitle: req.trainingTitle ?? null,
        trainingFullTitle: req.trainingData?.fullTitle ?? "—",
        quantityRequired: req.quantityRequired,
        globalAttained,
        minimumPerTheatre,
        theatreBreakdown,
        compliant,
        alternatives: req.alternatives.map((a: typeof req.alternatives[number]) => ({
          trainingType: a.trainingType,
          trainingTitle: a.trainingTitle,
          trainingFullTitle: a.trainingData?.fullTitle ?? "—",
        })),
      };
    });

    const specCompliant = requirements.every((r: typeof requirements[number]) => r.compliant);
    specialisations.push({ name: specName, compliant: specCompliant, requirements });
  }

  return NextResponse.json({ specialisations });
}
