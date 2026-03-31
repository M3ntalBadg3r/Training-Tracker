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
  if (studentsMode && trainingTitleParam) {
    return getStudents(trainingTitleParam, level, country, theatre, region);
  }

  // Get all APS program data
  const programData = await prisma.programData.findMany({
    where: { programName: APS_PROGRAM_NAME },
    include: {
      specialisation: true,
      trainingData: { select: { fullTitle: true } },
    },
    orderBy: [{ specialisationId: "asc" }, { trainingType: "asc" }],
  });

  if (programData.length === 0) {
    return NextResponse.json({
      specialisations: [],
      countries: [],
      theatres: [],
    });
  }

  // Get distinct countries, regions, and theatres
  const regionData = await prisma.regionData.findMany({ orderBy: { country: "asc" } });
  const countries = regionData.map((r) => r.country);
  const regionList = [...new Set(regionData.map((r) => r.region))].filter(Boolean).sort();
  const theatreStudents = await prisma.student.findMany({
    select: { theatre: true },
    distinct: ["theatre"],
    orderBy: { theatre: "asc" },
  });
  const theatreList = theatreStudents.map((s) => s.theatre).filter(Boolean);

  // Group by specialisation
  const specMap = new Map<string, typeof programData>();
  for (const pd of programData) {
    const key = pd.specialisation.name;
    if (!specMap.has(key)) specMap.set(key, []);
    specMap.get(key)!.push(pd);
  }

  const now = new Date();

  if (level === "country" && country) {
    const countryReqs = programData.filter((pd) => pd.level === "Country");
    // Filter out null trainingTitles (shouldn't occur for Country level, but be safe)
    const trainingTitles = [...new Set(countryReqs.map((pd) => pd.trainingTitle).filter((t): t is string => t !== null))];

    const attainedMap = await getAttainedByCountry(trainingTitles, country, now);
    const specialisations = buildSpecialisations(specMap, "Country", attainedMap);

    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList });
  }

  if (level === "region" && region) {
    const countryReqs = programData.filter((pd) => pd.level === "Country");
    const trainingTitles = [...new Set(countryReqs.map((pd) => pd.trainingTitle).filter((t): t is string => t !== null))];

    const attainedMap = await getAttainedByRegion(trainingTitles, region, now);
    const specialisations = buildSpecialisations(specMap, "Country", attainedMap);

    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList });
  }

  if (level === "theatre" && theatre) {
    const theatreReqs = programData.filter((pd) => pd.level === "Theatre");
    const trainingTitles = [...new Set(theatreReqs.map((pd) => pd.trainingTitle).filter((t): t is string => t !== null))];

    const attainedMap = await getAttainedByTheatre(trainingTitles, theatre, now);
    const specialisations = buildSpecialisations(specMap, "Theatre", attainedMap);

    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList });
  }

  if (level === "global") {
    // Global report: count compliant theatres per specialisation.
    // A theatre is compliant if it meets ALL theatre-level requirements for the specialisation.

    const allTheatres = await prisma.student.findMany({
      select: { theatre: true },
      distinct: ["theatre"],
    });
    const distinctTheatres = allTheatres.map((s) => s.theatre);

    const globalSpecialisations = [];

    for (const [specName, reqs] of specMap) {
      const theatreReqs = reqs.filter((r) => r.level === "Theatre" && r.trainingTitle !== null);
      const globalReqs = reqs.filter((r) => r.level === "Global");

      if (globalReqs.length === 0) continue;

      // Count theatres that meet all theatre-level requirements
      let compliantTheatreCount = 0;

      if (theatreReqs.length > 0) {
        const theatreTrainingTitles = [...new Set(theatreReqs.map((r) => r.trainingTitle).filter((t): t is string => t !== null))];

        for (const t of distinctTheatres) {
          const attainedMap = await getAttainedByTheatre(theatreTrainingTitles, t, now);
          const allMet = theatreReqs.every(
            (req) => req.trainingTitle !== null && (attainedMap.get(req.trainingTitle) || 0) >= req.quantityRequired
          );
          if (allMet) compliantTheatreCount++;
        }
      }

      const specReqs = globalReqs.map((req) => ({
        trainingType: req.trainingType ?? null,
        trainingTitle: req.trainingTitle ?? null,
        // Global requirements have no associated training; show a descriptive label
        trainingFullTitle: req.trainingData?.fullTitle ?? "Theatre Compliance",
        quantityRequired: req.quantityRequired,
        attained: compliantTheatreCount,
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

async function getAttainedByRegion(
  trainingTitles: string[],
  regionName: string,
  now: Date
): Promise<Map<string, number>> {
  if (trainingTitles.length === 0) return new Map();

  // Find all countries in this region
  const regionCountries = await prisma.regionData.findMany({
    where: { region: regionName },
    select: { country: true },
  });
  const countryList = regionCountries.map((r) => r.country);
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

  const countMap = new Map<string, number>();
  for (const [title, emails] of map) {
    countMap.set(title, emails.size);
  }
  return countMap;
}

async function getAttainedByCountry(
  trainingTitles: string[],
  country: string,
  now: Date
): Promise<Map<string, number>> {
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

  const countMap = new Map<string, number>();
  for (const [title, emails] of map) {
    countMap.set(title, emails.size);
  }
  return countMap;
}

async function getAttainedByTheatre(
  trainingTitles: string[],
  theatre: string,
  now: Date
): Promise<Map<string, number>> {
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

  const countMap = new Map<string, number>();
  for (const [title, emails] of map) {
    countMap.set(title, emails.size);
  }
  return countMap;
}

function buildSpecialisations(
  specMap: Map<string, Array<{
    level: string;
    trainingType: string | null;
    trainingTitle: string | null;
    trainingData: { fullTitle: string } | null;
    quantityRequired: number;
  }>>,
  level: string,
  attainedMap: Map<string, number>
) {
  const result = [];
  for (const [name, reqs] of specMap) {
    const levelReqs = reqs.filter((r) => r.level === level);
    if (levelReqs.length === 0) continue;

    result.push({
      name,
      requirements: levelReqs.map((req) => ({
        trainingType: req.trainingType ?? null,
        trainingTitle: req.trainingTitle ?? null,
        trainingFullTitle: req.trainingData?.fullTitle ?? "—",
        quantityRequired: req.quantityRequired,
        attained: req.trainingTitle ? (attainedMap.get(req.trainingTitle) || 0) : 0,
      })),
    });
  }
  return result;
}

async function getStudents(
  trainingTitle: string,
  level: string,
  country: string,
  theatre: string,
  region: string
) {
  const now = new Date();

  const whereClause: Record<string, unknown> = {
    trainingTitle,
    expiryDate: { gt: now },
  };

  if (level === "country" && country) {
    whereClause.student = { country };
  } else if (level === "region" && region) {
    const regionCountries = await prisma.regionData.findMany({
      where: { region },
      select: { country: true },
    });
    whereClause.student = { country: { in: regionCountries.map((r) => r.country) } };
  } else if (level === "theatre" && theatre) {
    whereClause.student = { theatre };
  }

  const records = await prisma.trainingTaken.findMany({
    where: whereClause,
    include: {
      student: { select: { fullName: true, email: true, country: true, theatre: true } },
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
  }));

  return NextResponse.json({ students });
}
