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
  const trainingTitleParam = request.nextUrl.searchParams.get("trainingTitle") || "";
  const studentsMode = request.nextUrl.searchParams.get("students") === "true";

  // If students mode, return the list of students for a specific training/country/theatre
  if (studentsMode && trainingTitleParam) {
    return getStudents(trainingTitleParam, level, country, theatre);
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

  // Get distinct countries and theatres
  const regions = await prisma.regionData.findMany({ orderBy: { country: "asc" } });
  const countries = regions.map((r) => r.country);
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
    // Country report: count students in the specified country per training
    const countryReqs = programData.filter((pd) => pd.level === "Country");
    const trainingTitles = [...new Set(countryReqs.map((pd) => pd.trainingTitle))];

    const attainedMap = await getAttainedByCountry(trainingTitles, country, now);

    const specialisations = buildSpecialisations(specMap, "Country", attainedMap);

    return NextResponse.json({ specialisations, countries, theatres: theatreList });
  }

  if (level === "theatre" && theatre) {
    // Theatre report: count students in the specified theatre per training
    const theatreReqs = programData.filter((pd) => pd.level === "Theatre");
    const trainingTitles = [...new Set(theatreReqs.map((pd) => pd.trainingTitle))];

    const attainedMap = await getAttainedByTheatre(trainingTitles, theatre, now);

    const specialisations = buildSpecialisations(specMap, "Theatre", attainedMap);

    return NextResponse.json({ specialisations, countries, theatres: theatreList });
  }

  if (level === "global") {
    // Global report: count compliant theatres per specialisation
    // A theatre is compliant for a specialisation if it meets ALL theatre-level requirements

    // Get all distinct theatres from students
    const allTheatres = await prisma.student.findMany({
      select: { theatre: true },
      distinct: ["theatre"],
    });
    const distinctTheatres = allTheatres.map((s) => s.theatre);

    // For each specialisation, check theatre compliance
    const globalSpecialisations = [];

    for (const [specName, reqs] of specMap) {
      const theatreReqs = reqs.filter((r) => r.level === "Theatre");
      const globalReqs = reqs.filter((r) => r.level === "Global");

      if (globalReqs.length === 0) continue;

      // For each theatre, check if it meets ALL theatre-level requirements for this specialisation
      let compliantTheatreCount = 0;

      if (theatreReqs.length > 0) {
        const theatreTrainingTitles = [...new Set(theatreReqs.map((r) => r.trainingTitle))];

        for (const t of distinctTheatres) {
          const attainedMap = await getAttainedByTheatre(theatreTrainingTitles, t, now);
          const allMet = theatreReqs.every(
            (req) => (attainedMap.get(req.trainingTitle) || 0) >= req.quantityRequired
          );
          if (allMet) compliantTheatreCount++;
        }
      }

      const attainedMap = new Map<string, number>();
      // For global requirements, the "attained" is the count of compliant theatres
      for (const gr of globalReqs) {
        attainedMap.set(gr.trainingTitle, compliantTheatreCount);
      }

      const specReqs = globalReqs.map((req) => ({
        trainingType: req.trainingType,
        trainingTitle: req.trainingTitle,
        trainingFullTitle: req.trainingData.fullTitle,
        quantityRequired: req.quantityRequired,
        attained: attainedMap.get(req.trainingTitle) || 0,
      }));

      globalSpecialisations.push({ name: specName, requirements: specReqs });
    }

    return NextResponse.json({
      specialisations: globalSpecialisations,
      countries,
      theatres: theatreList,
    });
  }

  // Default: return structure with empty attained (for initial load)
  const specialisations = Array.from(specMap.entries()).map(([name, reqs]) => ({
    name,
    requirements: reqs
      .filter((r) => r.level === "Country")
      .map((req) => ({
        trainingType: req.trainingType,
        trainingTitle: req.trainingTitle,
        trainingFullTitle: req.trainingData.fullTitle,
        quantityRequired: req.quantityRequired,
        attained: 0,
      })),
  }));

  return NextResponse.json({ specialisations, countries, theatres: theatreList });
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

  // Count distinct emails per trainingTitle
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
    trainingType: string;
    trainingTitle: string;
    trainingData: { fullTitle: string };
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
        trainingType: req.trainingType,
        trainingTitle: req.trainingTitle,
        trainingFullTitle: req.trainingData.fullTitle,
        quantityRequired: req.quantityRequired,
        attained: attainedMap.get(req.trainingTitle) || 0,
      })),
    });
  }
  return result;
}

async function getStudents(
  trainingTitle: string,
  level: string,
  country: string,
  theatre: string
) {
  const now = new Date();

  const whereClause: Record<string, unknown> = {
    trainingTitle,
    expiryDate: { gt: now },
  };

  if (level === "country" && country) {
    whereClause.student = { country };
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
