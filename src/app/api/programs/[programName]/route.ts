import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import {
  countriesInRegion,
  extractTitles,
  getEmailSetsByTitle,
  getEmailSetsByTitleAndTheatre,
  listTheatres,
  unionAttained,
  unionAttainedByTheatre,
} from "@/lib/program-compliance";

/**
 * Unified, data-driven program compliance endpoint. The program is identified
 * by the `[programName]` route segment (URL-decoded), so any program configured
 * in ProgramData gets a dashboard without code changes. This is the union of
 * the old hardcoded APS and Global Diamond routes:
 *  - Country / Region / Theatre levels behave like APS (count attained people).
 *  - The Global level supports both APS "compliant theatre count" semantics and
 *    Global Diamond per-title global counts with optional per-theatre minimums.
 *
 * A `meta` block reports the configured levels and whether any requirement uses
 * a per-theatre minimum, so the client can render the right sections.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ programName: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { programName: rawName } = await params;
  let programName: string;
  try {
    programName = decodeURIComponent(rawName);
  } catch {
    return NextResponse.json({ error: "Invalid program name" }, { status: 400 });
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({
      specialisations: [],
      countries: [],
      regions: [],
      theatres: [],
      meta: { levels: [], hasMinimumPerTheatre: false },
    });
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
    where: { programName },
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

  const meta = {
    levels: [...new Set(programData.map((pd: ProgramDataRow) => pd.level))],
    hasMinimumPerTheatre: programData.some(
      (pd: ProgramDataRow) => pd.minimumPerTheatre != null && pd.minimumPerTheatre > 0
    ),
  };

  if (programData.length === 0) {
    return NextResponse.json({
      specialisations: [],
      countries: [],
      regions: [],
      theatres: [],
      meta,
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
    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList, meta });
  }

  if (level === "region" && region) {
    const countryReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Country");
    const titles = extractTitles(countryReqs);
    const regionCountries = await countriesInRegion(region);
    const emailSets = regionCountries.length > 0
      ? await getEmailSetsByTitle(titles, now, { countries: regionCountries, companyIds: companyFilter })
      : new Map<string, Set<string>>();
    const specialisations = buildSpecialisations(specMap, "Country", emailSets);
    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList, meta });
  }

  if (level === "theatre" && theatre) {
    const theatreReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Theatre");
    const titles = extractTitles(theatreReqs);
    const emailSets = await getEmailSetsByTitle(titles, now, { theatre, companyIds: companyFilter });
    const specialisations = buildSpecialisations(specMap, "Theatre", emailSets);
    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList, meta });
  }

  if (level === "global") {
    const distinctTheatres = theatreList;

    // Global counts + per-theatre breakdown are needed for Global Diamond-style
    // requirements that carry a real training title / per-theatre minimum.
    const allTitles = extractTitles(programData);
    const globalEmailSets = await getEmailSetsByTitle(allTitles, now, { companyIds: companyFilter });
    const byTitleAndTheatre = meta.hasMinimumPerTheatre
      ? await getEmailSetsByTitleAndTheatre(allTitles, now, companyFilter)
      : new Map<string, Map<string, Set<string>>>();

    const globalSpecialisations = [];

    for (const [specName, reqs] of specMap) {
      const theatreReqs = reqs.filter((r: ProgramDataRow) => r.level === "Theatre" && r.trainingTitle !== null);
      const globalReqs = reqs.filter((r: ProgramDataRow) => r.level === "Global");

      if (globalReqs.length === 0) continue;

      // APS "count of compliant theatres" — a theatre is compliant when it meets
      // every theatre-level requirement for this specialisation.
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

      const specReqs = globalReqs.map((req: ProgramDataRow) => {
        const hasTrainingTitle = req.trainingTitle !== null;
        const globalAttained = unionAttained(req, globalEmailSets);
        const minimumPerTheatre = req.minimumPerTheatre ?? null;

        let theatreBreakdown: { theatre: string; count: number; compliant: boolean }[] | null = null;
        if (minimumPerTheatre !== null && minimumPerTheatre > 0) {
          theatreBreakdown = unionAttainedByTheatre(req, byTitleAndTheatre, distinctTheatres).map((t) => ({
            theatre: t.theatre,
            count: t.count,
            compliant: t.count >= minimumPerTheatre,
          }));
        }

        // For title-bearing requirements the "attained" figure is the global
        // student count; for the APS theatre-compliance placeholder it's the
        // number of compliant theatres.
        const attained = hasTrainingTitle ? globalAttained : compliantTheatreCount;
        const primaryMet = attained >= req.quantityRequired;
        const theatresMet = theatreBreakdown === null || theatreBreakdown.every((t) => t.compliant);
        const compliant = primaryMet && theatresMet;

        return {
          trainingType: req.trainingType ?? null,
          trainingTitle: req.trainingTitle ?? null,
          trainingFullTitle: req.trainingData?.fullTitle ?? "Theatre Compliance",
          quantityRequired: req.quantityRequired,
          attained,
          globalAttained,
          minimumPerTheatre,
          theatreBreakdown,
          compliant,
          alternatives: req.alternatives.map((a: ProgramDataRow["alternatives"][number]) => ({
            trainingType: a.trainingType,
            trainingTitle: a.trainingTitle,
            trainingFullTitle: a.trainingData?.fullTitle ?? "—",
          })),
        };
      });

      const specCompliant = specReqs.every((r) => r.compliant);
      globalSpecialisations.push({ name: specName, compliant: specCompliant, requirements: specReqs });
    }

    return NextResponse.json({
      specialisations: globalSpecialisations,
      countries,
      regions: regionList,
      theatres: theatreList,
      meta,
    });
  }

  const specialisations = buildSpecialisations(specMap, "Country", new Map());
  return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList, meta });
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
