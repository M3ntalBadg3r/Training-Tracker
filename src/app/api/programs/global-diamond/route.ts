import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";

const GLOBAL_DIAMOND_PROGRAM_NAME = "Global Diamond";

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({ specialisations: [] });
  }

  // Get all Global Diamond program data (all entries are Global level with specific training)
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

  // Get all distinct theatres (within scope)
  const studentScope = companyFilter ? { companyId: { in: companyFilter } } : {};
  const theatreStudents = await prisma.student.findMany({
    where: studentScope,
    select: { theatre: true },
    distinct: ["theatre"],
    orderBy: { theatre: "asc" },
  });
  const theatres = theatreStudents.map((s: typeof theatreStudents[number]) => s.theatre).filter(Boolean);

  // Collect ALL training titles (primary + alternatives) across all requirements
  const allTrainingTitles = new Set<string>();
  for (const pd of programData) {
    if (pd.trainingTitle) allTrainingTitles.add(pd.trainingTitle);
    for (const alt of pd.alternatives) {
      allTrainingTitles.add(alt.trainingTitle);
    }
  }
  const allTitlesArray = [...allTrainingTitles];

  // Fetch all active training records for all relevant training titles
  const globalResults = allTitlesArray.length > 0
    ? await prisma.trainingTaken.findMany({
        where: {
          trainingTitle: { in: allTitlesArray },
          expiryDate: { gt: now },
          ...(companyFilter ? { student: { companyId: { in: companyFilter } } } : {}),
        },
        select: { trainingTitle: true, email: true, student: { select: { theatre: true } } },
      })
    : [];

  // Build per-trainingTitle email sets (for global count)
  const titleEmailMap = new Map<string, Set<string>>();
  // Build per-trainingTitle per-theatre email sets (for theatre breakdown)
  const titleTheatreEmailMap = new Map<string, Map<string, Set<string>>>();

  for (const r of globalResults) {
    // Global email set
    if (!titleEmailMap.has(r.trainingTitle)) titleEmailMap.set(r.trainingTitle, new Set());
    titleEmailMap.get(r.trainingTitle)!.add(r.email);

    // Theatre email set
    if (!titleTheatreEmailMap.has(r.trainingTitle)) titleTheatreEmailMap.set(r.trainingTitle, new Map());
    const byTheatre = titleTheatreEmailMap.get(r.trainingTitle)!;
    const theatre = r.student.theatre;
    if (!byTheatre.has(theatre)) byTheatre.set(theatre, new Set());
    byTheatre.get(theatre)!.add(r.email);
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

      // Collect all titles for this requirement (primary + alternatives)
      const allReqTitles = [title, ...req.alternatives.map((a) => a.trainingTitle)].filter(Boolean) as string[];

      // Union unique students across all titles for global count
      const globalUnion = new Set<string>();
      for (const t of allReqTitles) {
        const set = titleEmailMap.get(t);
        if (set) for (const email of set) globalUnion.add(email);
      }
      const globalAttained = globalUnion.size;

      const minimumPerTheatre = req.minimumPerTheatre ?? null;

      // Theatre breakdown (only if minimumPerTheatre is set)
      let theatreBreakdown: { theatre: string; count: number; compliant: boolean }[] | null = null;
      if (minimumPerTheatre !== null && minimumPerTheatre > 0) {
        theatreBreakdown = theatres.map((t: typeof theatres[number]) => {
          // Union unique students across all titles for this theatre
          const theatreUnion = new Set<string>();
          for (const reqTitle of allReqTitles) {
            const byTheatre = titleTheatreEmailMap.get(reqTitle);
            const set = byTheatre?.get(t);
            if (set) for (const email of set) theatreUnion.add(email);
          }
          const count = theatreUnion.size;
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
