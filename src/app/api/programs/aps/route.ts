import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

const APS_PROGRAM_NAME = "Authorized Professional Services (APS)";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const level = request.nextUrl.searchParams.get("level") || "country";
  const country = request.nextUrl.searchParams.get("country") || "";
  const theatre = request.nextUrl.searchParams.get("theatre") || "";
  const region = request.nextUrl.searchParams.get("region") || "";
  const trainingTitleParam = request.nextUrl.searchParams.get("trainingTitle") || "";
  const studentsMode = request.nextUrl.searchParams.get("students") === "true";

  // If students mode, return the list of students for a specific training/country/theatre
  // trainingTitle can be comma-separated for OR logic (primary + alternatives)
  if (studentsMode && trainingTitleParam) {
    const titles = trainingTitleParam.split(",").map((t) => t.trim()).filter(Boolean);
    return getStudents(titles, level, country, theatre, region);
  }

  // Get all APS program data
  const programData = await prisma.programData.findMany({
    where: { programName: APS_PROGRAM_NAME },
    include: {
      specialisation: true,
      trainingData: { select: { fullTitle: true } },
      alternatives: {
        include: { trainingData: { select: { fullTitle: true } } },
      },
    },
    orderBy: [{ specialisationId: "asc" }, { trainingType: "asc" }],
  });

  type ProgramDataRow = typeof programData[number];

  if (programData.length === 0) {
    return NextResponse.json({
      specialisations: [],
      countries: [],
      theatres: [],
    });
  }

  // Get distinct countries, regions, and theatres
  const regionData = await prisma.regionData.findMany({ orderBy: { country: "asc" } });
  const countries = regionData.map((r: typeof regionData[number]) => r.country);
  const regionList = [...new Set(regionData.map((r: typeof regionData[number]) => r.region))].filter(Boolean).sort();
  const theatreStudents = await prisma.student.findMany({
    select: { theatre: true },
    distinct: ["theatre"],
    orderBy: { theatre: "asc" },
  });
  const theatreList = theatreStudents.map((s: typeof theatreStudents[number]) => s.theatre).filter(Boolean);

  // Group by specialisation
  const specMap = new Map<string, ProgramDataRow[]>();
  for (const pd of programData) {
    const key = pd.specialisation.name;
    if (!specMap.has(key)) specMap.set(key, []);
    specMap.get(key)!.push(pd);
  }

  const now = new Date();

  /** Extract unique non-null training titles from program data rows (including alternatives) */
  function extractTrainingTitles(rows: ProgramDataRow[]): string[] {
    const titles = new Set<string>();
    for (const pd of rows) {
      if (pd.trainingTitle) titles.add(pd.trainingTitle);
      for (const alt of pd.alternatives) {
        titles.add(alt.trainingTitle);
      }
    }
    return [...titles];
  }

  if (level === "country" && country) {
    const countryReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Country");
    const trainingTitles = extractTrainingTitles(countryReqs);

    const emailSets = await getEmailSetsByCountry(trainingTitles, country, now);
    const specialisations = buildSpecialisations(specMap, "Country", emailSets);

    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList });
  }

  if (level === "region" && region) {
    const countryReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Country");
    const trainingTitles = extractTrainingTitles(countryReqs);

    const emailSets = await getEmailSetsByRegion(trainingTitles, region, now);
    const specialisations = buildSpecialisations(specMap, "Country", emailSets);

    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList });
  }

  if (level === "theatre" && theatre) {
    const theatreReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Theatre");
    const trainingTitles = extractTrainingTitles(theatreReqs);

    const emailSets = await getEmailSetsByTheatre(trainingTitles, theatre, now);
    const specialisations = buildSpecialisations(specMap, "Theatre", emailSets);

    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList });
  }

  if (level === "global") {
    // Global report: count compliant theatres per specialisation.
    // A theatre is compliant if it meets ALL theatre-level requirements for the specialisation.

    const allTheatres = await prisma.student.findMany({
      select: { theatre: true },
      distinct: ["theatre"],
    });
    const distinctTheatres = allTheatres.map((s: typeof allTheatres[number]) => s.theatre);

    const globalSpecialisations = [];

    for (const [specName, reqs] of specMap) {
      const theatreReqs = reqs.filter((r: ProgramDataRow) => r.level === "Theatre" && r.trainingTitle !== null);
      const globalReqs = reqs.filter((r: ProgramDataRow) => r.level === "Global");

      if (globalReqs.length === 0) continue;

      // Count theatres that meet all theatre-level requirements
      let compliantTheatreCount = 0;

      if (theatreReqs.length > 0) {
        const theatreTrainingTitles = extractTrainingTitles(theatreReqs);

        for (const t of distinctTheatres) {
          const emailSets = await getEmailSetsByTheatre(theatreTrainingTitles, t, now);
          // Check each requirement individually (union primary + alternatives)
          const allMet = theatreReqs.every((req: ProgramDataRow) => {
            if (!req.trainingTitle) return false;
            const allTitles = [req.trainingTitle, ...req.alternatives.map((a) => a.trainingTitle)];
            const union = new Set<string>();
            for (const title of allTitles) {
              const set = emailSets.get(title);
              if (set) for (const email of set) union.add(email);
            }
            return union.size >= req.quantityRequired;
          });
          if (allMet) compliantTheatreCount++;
        }
      }

      const specReqs = globalReqs.map((req: ProgramDataRow) => ({
        trainingType: req.trainingType ?? null,
        trainingTitle: req.trainingTitle ?? null,
        // Global requirements have no associated training; show a descriptive label
        trainingFullTitle: req.trainingData?.fullTitle ?? "Theatre Compliance",
        quantityRequired: req.quantityRequired,
        attained: compliantTheatreCount,
        alternatives: req.alternatives.map((a) => ({
          trainingType: a.trainingType,
          trainingTitle: a.trainingTitle,
          trainingFullTitle: a.trainingData?.fullTitle ?? "—",
        })),
      }));

      globalSpecialisations.push({ name: specName, requirements: specReqs });
    }

    return NextResponse.json({
      specialisations: globalSpecialisations,
      countries,
      regions: regionList,
      theatres: theatreList,
    });
  }

  // Default: return structure for initial load
  const specialisations = buildSpecialisations(specMap, "Country", new Map());

  return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList });
}

async function getEmailSetsByRegion(
  trainingTitles: string[],
  regionName: string,
  now: Date
): Promise<Map<string, Set<string>>> {
  if (trainingTitles.length === 0) return new Map();

  // Find all countries in this region
  const regionCountries = await prisma.regionData.findMany({
    where: { region: regionName },
    select: { country: true },
  });
  const countryList = regionCountries.map((r: typeof regionCountries[number]) => r.country);
  if (countryList.length === 0) return new Map();

  const results = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: trainingTitles },
      expiryDate: { gt: now },
      student: { country: { in: countryList } },
    },
    select: { trainingTitle: true, email: true },
  });

  const map = new Map<string, Set<string>>();
  for (const r of results) {
    if (!map.has(r.trainingTitle)) map.set(r.trainingTitle, new Set());
    map.get(r.trainingTitle)!.add(r.email);
  }
  return map;
}

async function getEmailSetsByCountry(
  trainingTitles: string[],
  country: string,
  now: Date
): Promise<Map<string, Set<string>>> {
  if (trainingTitles.length === 0) return new Map();

  const results = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: trainingTitles },
      expiryDate: { gt: now },
      student: { country },
    },
    select: { trainingTitle: true, email: true },
  });

  const map = new Map<string, Set<string>>();
  for (const r of results) {
    if (!map.has(r.trainingTitle)) map.set(r.trainingTitle, new Set());
    map.get(r.trainingTitle)!.add(r.email);
  }
  return map;
}

async function getEmailSetsByTheatre(
  trainingTitles: string[],
  theatre: string,
  now: Date
): Promise<Map<string, Set<string>>> {
  if (trainingTitles.length === 0) return new Map();

  const results = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: trainingTitles },
      expiryDate: { gt: now },
      student: { theatre },
    },
    select: { trainingTitle: true, email: true },
  });

  const map = new Map<string, Set<string>>();
  for (const r of results) {
    if (!map.has(r.trainingTitle)) map.set(r.trainingTitle, new Set());
    map.get(r.trainingTitle)!.add(r.email);
  }
  return map;
}

function buildSpecialisations(
  specMap: Map<string, Array<{
    level: string;
    trainingType: string | null;
    trainingTitle: string | null;
    trainingData: { fullTitle: string } | null;
    quantityRequired: number;
    alternatives: Array<{
      trainingType: string;
      trainingTitle: string;
      trainingData: { fullTitle: string } | null;
    }>;
  }>>,
  level: string,
  emailSets: Map<string, Set<string>>
) {
  const result = [];
  for (const [name, reqs] of specMap) {
    const levelReqs = reqs.filter((r) => r.level === level);
    if (levelReqs.length === 0) continue;

    result.push({
      name,
      requirements: levelReqs.map((req) => {
        // Union unique students across primary + alternatives
        const allTitles = [req.trainingTitle, ...req.alternatives.map((a) => a.trainingTitle)].filter(Boolean) as string[];
        const union = new Set<string>();
        for (const title of allTitles) {
          const set = emailSets.get(title);
          if (set) for (const email of set) union.add(email);
        }

        return {
          trainingType: req.trainingType ?? null,
          trainingTitle: req.trainingTitle ?? null,
          trainingFullTitle: req.trainingData?.fullTitle ?? "—",
          quantityRequired: req.quantityRequired,
          attained: req.trainingTitle ? union.size : 0,
          alternatives: req.alternatives.map((a) => ({
            trainingType: a.trainingType,
            trainingTitle: a.trainingTitle,
            trainingFullTitle: a.trainingData?.fullTitle ?? "—",
          })),
        };
      }),
    });
  }
  return result;
}

async function getStudents(
  trainingTitles: string[],
  level: string,
  country: string,
  theatre: string,
  region: string
) {
  const now = new Date();

  const whereClause: Record<string, unknown> = {
    trainingTitle: { in: trainingTitles },
    expiryDate: { gt: now },
  };

  if (level === "country" && country) {
    whereClause.student = { country };
  } else if (level === "region" && region) {
    const regionCountries = await prisma.regionData.findMany({
      where: { region },
      select: { country: true },
    });
    whereClause.student = { country: { in: regionCountries.map((r: typeof regionCountries[number]) => r.country) } };
  } else if (level === "theatre" && theatre) {
    whereClause.student = { theatre };
  }

  const records = await prisma.trainingTaken.findMany({
    where: whereClause,
    include: {
      student: { select: { fullName: true, email: true, country: true, theatre: true } },
      trainingData: { select: { fullTitle: true } },
    },
    orderBy: { student: { fullName: "asc" } },
  });

  // Deduplicate by email (take the latest completion)
  const emailMap = new Map<string, typeof records[0]>();
  for (const r of records) {
    const existing = emailMap.get(r.email);
    if (!existing || r.completedDate > existing.completedDate) {
      emailMap.set(r.email, r);
    }
  }

  const students = Array.from(emailMap.values()).map((r) => ({
    fullName: r.student.fullName,
    email: r.email,
    country: r.student.country,
    theatre: r.student.theatre,
    completedDate: r.completedDate.toISOString().split("T")[0],
    expiryDate: r.expiryDate.toISOString().split("T")[0],
    training: r.trainingData?.fullTitle ?? r.trainingTitle,
  }));

  return NextResponse.json({ students });
}
