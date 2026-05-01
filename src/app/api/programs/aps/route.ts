import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import {
  countriesInRegion,
  extractTitles,
  getEmailSetsByTitle,
  listTheatres,
  unionAttained,
} from "@/lib/program-compliance";

const APS_PROGRAM_NAME = "Authorized Professional Services (APS)";

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
    return NextResponse.json({ specialisations: [], countries: [], regions: [], theatres: [] });
  }

  const level = request.nextUrl.searchParams.get("level") || "country";
  const country = request.nextUrl.searchParams.get("country") || "";
  const theatre = request.nextUrl.searchParams.get("theatre") || "";
  const region = request.nextUrl.searchParams.get("region") || "";
  const trainingTitleParam = request.nextUrl.searchParams.get("trainingTitle") || "";
  const studentsMode = request.nextUrl.searchParams.get("students") === "true";

  if (studentsMode && trainingTitleParam) {
    const titles = trainingTitleParam.split(",").map((t) => t.trim()).filter(Boolean);
    return getStudents(titles, level, country, theatre, region, companyFilter);
  }

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

  const regionData = await prisma.regionData.findMany({ orderBy: { country: "asc" } });
  const countries = regionData.map((r: typeof regionData[number]) => r.country);
  const regionList = [...new Set(regionData.map((r: typeof regionData[number]) => r.region))].filter(Boolean).sort();
  const theatreList = await listTheatres(companyFilter);

  const specMap = new Map<string, ProgramDataRow[]>();
  for (const pd of programData) {
    const key = pd.specialisation.name;
    if (!specMap.has(key)) specMap.set(key, []);
    specMap.get(key)!.push(pd);
  }

  const now = new Date();

  if (level === "country" && country) {
    const countryReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Country");
    const titles = extractTitles(countryReqs);
    const emailSets = await getEmailSetsByTitle(titles, now, { country, companyIds: companyFilter });
    const specialisations = buildSpecialisations(specMap, "Country", emailSets);
    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList });
  }

  if (level === "region" && region) {
    const countryReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Country");
    const titles = extractTitles(countryReqs);
    const regionCountries = await countriesInRegion(region);
    const emailSets = regionCountries.length > 0
      ? await getEmailSetsByTitle(titles, now, { countries: regionCountries, companyIds: companyFilter })
      : new Map<string, Set<string>>();
    const specialisations = buildSpecialisations(specMap, "Country", emailSets);
    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList });
  }

  if (level === "theatre" && theatre) {
    const theatreReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Theatre");
    const titles = extractTitles(theatreReqs);
    const emailSets = await getEmailSetsByTitle(titles, now, { theatre, companyIds: companyFilter });
    const specialisations = buildSpecialisations(specMap, "Theatre", emailSets);
    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList });
  }

  if (level === "global") {
    const distinctTheatres = await listTheatres(companyFilter);

    const globalSpecialisations = [];

    for (const [specName, reqs] of specMap) {
      const theatreReqs = reqs.filter((r: ProgramDataRow) => r.level === "Theatre" && r.trainingTitle !== null);
      const globalReqs = reqs.filter((r: ProgramDataRow) => r.level === "Global");

      if (globalReqs.length === 0) continue;

      let compliantTheatreCount = 0;

      if (theatreReqs.length > 0) {
        const titles = extractTitles(theatreReqs);

        for (const t of distinctTheatres) {
          const emailSets = await getEmailSetsByTitle(titles, now, { theatre: t, companyIds: companyFilter });
          const allMet = theatreReqs.every((req: ProgramDataRow) => {
            if (!req.trainingTitle) return false;
            return unionAttained(req, emailSets) >= req.quantityRequired;
          });
          if (allMet) compliantTheatreCount++;
        }
      }

      const specReqs = globalReqs.map((req: ProgramDataRow) => ({
        trainingType: req.trainingType ?? null,
        trainingTitle: req.trainingTitle ?? null,
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

  const specialisations = buildSpecialisations(specMap, "Country", new Map());
  return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList });
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
      requirements: levelReqs.map((req) => ({
        trainingType: req.trainingType ?? null,
        trainingTitle: req.trainingTitle ?? null,
        trainingFullTitle: req.trainingData?.fullTitle ?? "—",
        quantityRequired: req.quantityRequired,
        attained: req.trainingTitle ? unionAttained(req, emailSets) : 0,
        alternatives: req.alternatives.map((a) => ({
          trainingType: a.trainingType,
          trainingTitle: a.trainingTitle,
          trainingFullTitle: a.trainingData?.fullTitle ?? "—",
        })),
      })),
    });
  }
  return result;
}

async function getStudents(
  trainingTitles: string[],
  level: string,
  country: string,
  theatre: string,
  region: string,
  companyFilter: number[] | null
) {
  const now = new Date();

  const studentFilter: Record<string, unknown> = {};
  if (level === "country" && country) {
    studentFilter.country = country;
  } else if (level === "region" && region) {
    const regionCountries = await countriesInRegion(region);
    studentFilter.country = { in: regionCountries };
  } else if (level === "theatre" && theatre) {
    studentFilter.theatre = theatre;
  }
  if (companyFilter && companyFilter.length > 0) {
    studentFilter.companyId = { in: companyFilter };
  }

  const records = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: trainingTitles },
      expiryDate: { gt: now },
      ...(Object.keys(studentFilter).length > 0 ? { student: studentFilter } : {}),
    },
    include: {
      student: { select: { fullName: true, email: true, country: true, theatre: true } },
      trainingData: { select: { fullTitle: true } },
    },
    orderBy: { student: { fullName: "asc" } },
  });

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
