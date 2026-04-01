import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

const GLOBAL_DIAMOND_PROGRAM_NAME = "Global Diamond";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  // Get all Global Diamond program data (all entries are Global level with specific training)
  const programData = await prisma.programData.findMany({
    where: { programName: GLOBAL_DIAMOND_PROGRAM_NAME },
    include: {
      specialisation: true,
      trainingData: { select: { fullTitle: true } },
    },
    orderBy: [{ specialisationId: "asc" }, { trainingType: "asc" }],
  });

  if (programData.length === 0) {
    return NextResponse.json({ specialisations: [] });
  }

  const now = new Date();

  // Get all distinct theatres
  const theatreStudents = await prisma.student.findMany({
    select: { theatre: true },
    distinct: ["theatre"],
    orderBy: { theatre: "asc" },
  });
  const theatres = theatreStudents.map((s: typeof theatreStudents[number]) => s.theatre).filter(Boolean);

  // Collect all training titles that have minimumPerTheatre set
  const titlesWithTheatreMin = programData
    .filter((pd: typeof programData[number]) => pd.trainingTitle !== null && (pd.minimumPerTheatre ?? 0) > 0)
    .map((pd: typeof programData[number]) => pd.trainingTitle as string);

  // Fetch all active training records for all relevant training titles
  const allTrainingTitles = [...new Set(
    programData.filter((pd: typeof programData[number]) => pd.trainingTitle !== null).map((pd: typeof programData[number]) => pd.trainingTitle as string)
  )];

  // Global count: distinct emails per trainingTitle with active training
  const globalResults = allTrainingTitles.length > 0
    ? await prisma.trainingTaken.findMany({
        where: {
          trainingTitle: { in: allTrainingTitles },
          expiryDate: { gt: now },
        },
        select: { trainingTitle: true, email: true, student: { select: { theatre: true } } },
      })
    : [];

  // Build global attained map: trainingTitle -> Set<email>
  const globalAttainedMap = new Map<string, Set<string>>();
  for (const r of globalResults) {
    if (!globalAttainedMap.has(r.trainingTitle)) globalAttainedMap.set(r.trainingTitle, new Set());
    globalAttainedMap.get(r.trainingTitle)!.add(r.email);
  }

  // Build per-theatre attained map: trainingTitle -> theatre -> Set<email>
  const theatreAttainedMap = new Map<string, Map<string, Set<string>>>();
  if (titlesWithTheatreMin.length > 0) {
    for (const r of globalResults) {
      if (!titlesWithTheatreMin.includes(r.trainingTitle)) continue;
      if (!theatreAttainedMap.has(r.trainingTitle)) theatreAttainedMap.set(r.trainingTitle, new Map());
      const byTheatre = theatreAttainedMap.get(r.trainingTitle)!;
      const theatre = r.student.theatre;
      if (!byTheatre.has(theatre)) byTheatre.set(theatre, new Set());
      byTheatre.get(theatre)!.add(r.email);
    }
  }

  // Group by specialisation
  const specMap = new Map<string, typeof programData>();
  for (const pd of programData) {
    const key = pd.specialisation.name;
    if (!specMap.has(key)) specMap.set(key, []);
    specMap.get(key)!.push(pd);
  }

  const specialisations = [];

  for (const [specName, reqs] of specMap) {
    const requirements = reqs.map((req: typeof programData[number]) => {
      const title = req.trainingTitle;
      const globalAttained = title ? (globalAttainedMap.get(title)?.size ?? 0) : 0;
      const minimumPerTheatre = req.minimumPerTheatre ?? null;

      // Theatre breakdown (only if minimumPerTheatre is set)
      let theatreBreakdown: { theatre: string; count: number; compliant: boolean }[] | null = null;
      if (title && minimumPerTheatre !== null && minimumPerTheatre > 0) {
        const byTheatre = theatreAttainedMap.get(title);
        theatreBreakdown = theatres.map((t: typeof theatres[number]) => {
          const count = byTheatre?.get(t)?.size ?? 0;
          return { theatre: t, count, compliant: count >= minimumPerTheatre };
        });
      }

      // Requirement is compliant if global total met AND all theatres meet minimum
      const globalMet = globalAttained >= req.quantityRequired;
      const theatresMet =
        theatreBreakdown === null || theatreBreakdown.every((t) => t.compliant);
      const compliant = globalMet && theatresMet;

      return {
        trainingType: req.trainingType ?? null,
        trainingTitle: title ?? null,
        trainingFullTitle: req.trainingData?.fullTitle ?? "—",
        quantityRequired: req.quantityRequired,
        globalAttained,
        minimumPerTheatre,
        theatreBreakdown,
        compliant,
      };
    });

    const specCompliant = requirements.every((r: typeof requirements[number]) => r.compliant);
    specialisations.push({ name: specName, compliant: specCompliant, requirements });
  }

  return NextResponse.json({ specialisations });
}
