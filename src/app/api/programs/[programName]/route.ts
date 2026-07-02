import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { addMonths } from "@/lib/utils";
import {
  countriesInRegion,
  extractTitles,
  getEmailSetsByTitle,
  getEmailSetsByTitleAndTheatre,
  listTheatres,
  unionAttained,
  unionAttainedByTheatre,
  evaluateTierLadder,
  type ComplianceScope,
  type ProgramRequirement,
  type TierLadderInput,
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
      horizonMonths: 0,
    });
  }

  const level = request.nextUrl.searchParams.get("level") || "country";
  const country = request.nextUrl.searchParams.get("country") || "";
  const theatre = request.nextUrl.searchParams.get("theatre") || "";
  const region = request.nextUrl.searchParams.get("region") || "";
  const trainingTitleParam = request.nextUrl.searchParams.get("trainingTitle") || "";
  const studentsMode = request.nextUrl.searchParams.get("students") === "true";

  // Optional forward-looking projection: recompute compliance as it will stand
  // `horizonMonths` from now, so upcoming certificate expiries surface before
  // they break compliance. Only a fixed set of horizons is accepted.
  const rawHorizon = parseInt(request.nextUrl.searchParams.get("horizonMonths") || "0", 10);
  const horizonMonths = [3, 6, 12].includes(rawHorizon) ? rawHorizon : 0;

  if (studentsMode && trainingTitleParam) {
    const titles = trainingTitleParam.split(",").map((t) => t.trim()).filter(Boolean);
    return getStudents(titles, level, country, theatre, region, companyFilter);
  }

  const [programData, program, tierRows] = await Promise.all([
    prisma.programData.findMany({
      where: { programName },
      include: {
        specialisation: true,
        trainingData: { select: { fullTitle: true } },
        alternatives: {
          include: { trainingData: { select: { fullTitle: true } } },
        },
      },
      orderBy: [{ specialisationId: "asc" }, { trainingType: "asc" }],
    }),
    prisma.program.findUnique({ where: { name: programName } }),
    prisma.programTier.findMany({ where: { programName }, orderBy: { sortOrder: "asc" } }),
  ]);

  type ProgramDataRow = typeof programData[number];

  const isTiered = program?.isTiered === true;
  const deploymentMode = program?.deploymentMode ?? "flat";

  const meta = {
    levels: [...new Set(programData.map((pd: ProgramDataRow) => pd.level))],
    hasMinimumPerTheatre: programData.some(
      (pd: ProgramDataRow) => pd.minimumPerTheatre != null && pd.minimumPerTheatre > 0
    ),
    isTiered,
    deploymentMode,
  };

  if (programData.length === 0 && !isTiered) {
    return NextResponse.json({
      specialisations: [],
      countries: [],
      regions: [],
      theatres: [],
      meta,
      horizonMonths,
    });
  }

  const regionData = await prisma.regionData.findMany({ orderBy: { country: "asc" } });
  const countries = regionData.map((r: typeof regionData[number]) => r.country);
  const regionList = [...new Set(regionData.map((r: typeof regionData[number]) => r.region))].filter(Boolean).sort();
  const theatreList = await listTheatres(companyFilter);

  // The specialisation display covers only qualifying, specialisation-scoped
  // rows. Tier-scoped rows (specialisationId null) and deployment-purpose rows
  // are handled by the tier ladder instead.
  const specMap = new Map<string, ProgramDataRow[]>();
  for (const pd of programData) {
    if (pd.specialisationId == null || !pd.specialisation) continue;
    if (pd.purpose !== "qualification") continue;
    const key = pd.specialisation.name;
    if (!specMap.has(key)) specMap.set(key, []);
    specMap.get(key)!.push(pd);
  }

  const now = new Date();
  const horizonDate = horizonMonths > 0 ? addMonths(now, horizonMonths) : null;

  if (level === "country" && country) {
    const countryReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Country");
    const titles = extractTitles(countryReqs);
    const scope: ComplianceScope = { country, companyIds: companyFilter };
    const emailSets = await getEmailSetsByTitle(titles, now, scope);
    const projectedEmailSets = horizonDate
      ? await getEmailSetsByTitle(titles, horizonDate, scope)
      : null;
    const specialisations = buildSpecialisations(specMap, "Country", emailSets, projectedEmailSets);
    const tiers = isTiered
      ? await computeTierBlock({ levelName: "Country", scope, useTheatre: false, theatres: [], companyFilter, rows: programData, tiers: tierRows, deploymentMode, now, horizonDate })
      : undefined;
    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList, meta, horizonMonths, tiers });
  }

  if (level === "region" && region) {
    const countryReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Country");
    const titles = extractTitles(countryReqs);
    const regionCountries = await countriesInRegion(region);
    const scope: ComplianceScope = { countries: regionCountries, companyIds: companyFilter };
    const emailSets = regionCountries.length > 0
      ? await getEmailSetsByTitle(titles, now, scope)
      : new Map<string, Set<string>>();
    const projectedEmailSets = horizonDate && regionCountries.length > 0
      ? await getEmailSetsByTitle(titles, horizonDate, scope)
      : null;
    const specialisations = buildSpecialisations(specMap, "Country", emailSets, projectedEmailSets);
    const tiers = isTiered
      ? await computeTierBlock({ levelName: "Country", scope, useTheatre: false, theatres: [], companyFilter, rows: programData, tiers: tierRows, deploymentMode, now, horizonDate })
      : undefined;
    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList, meta, horizonMonths, tiers });
  }

  if (level === "theatre" && theatre) {
    const theatreReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Theatre");
    const titles = extractTitles(theatreReqs);
    const scope: ComplianceScope = { theatre, companyIds: companyFilter };
    const emailSets = await getEmailSetsByTitle(titles, now, scope);
    const projectedEmailSets = horizonDate
      ? await getEmailSetsByTitle(titles, horizonDate, scope)
      : null;
    const specialisations = buildSpecialisations(specMap, "Theatre", emailSets, projectedEmailSets);
    const tiers = isTiered
      ? await computeTierBlock({ levelName: "Theatre", scope, useTheatre: false, theatres: [], companyFilter, rows: programData, tiers: tierRows, deploymentMode, now, horizonDate })
      : undefined;
    return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList, meta, horizonMonths, tiers });
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

    // Projected (forward-looking) variants, computed once when a horizon is set.
    const projectedGlobalEmailSets = horizonDate
      ? await getEmailSetsByTitle(allTitles, horizonDate, { companyIds: companyFilter })
      : null;
    const projectedByTitleAndTheatre = horizonDate && meta.hasMinimumPerTheatre
      ? await getEmailSetsByTitleAndTheatre(allTitles, horizonDate, companyFilter)
      : new Map<string, Map<string, Set<string>>>();

    // Count of compliant theatres for a given as-of date (APS semantics — a
    // theatre is compliant when it meets every theatre-level requirement).
    async function countCompliantTheatres(theatreReqs: ProgramDataRow[], asOf: Date): Promise<number> {
      if (theatreReqs.length === 0) return 0;
      const titles = extractTitles(theatreReqs);
      let count = 0;
      for (const t of distinctTheatres) {
        const emailSets = await getEmailSetsByTitle(titles, asOf, { theatre: t, companyIds: companyFilter });
        const allMet = theatreReqs.every((req: ProgramDataRow) => {
          if (!req.trainingTitle) return false;
          return unionAttained(req, emailSets) >= req.quantityRequired;
        });
        if (allMet) count++;
      }
      return count;
    }

    const globalSpecialisations = [];

    for (const [specName, reqs] of specMap) {
      const theatreReqs = reqs.filter((r: ProgramDataRow) => r.level === "Theatre" && r.trainingTitle !== null);
      const globalReqs = reqs.filter((r: ProgramDataRow) => r.level === "Global");

      if (globalReqs.length === 0) continue;

      const compliantTheatreCount = await countCompliantTheatres(theatreReqs, now);
      const projectedCompliantTheatreCount = horizonDate
        ? await countCompliantTheatres(theatreReqs, horizonDate)
        : 0;

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

        // Forward-looking projection at the selected horizon (if any).
        let projectedGlobalAttained: number | undefined;
        let projectedAttained: number | undefined;
        let projectedTheatreBreakdown: { theatre: string; count: number; compliant: boolean }[] | null | undefined;
        let projectedCompliant: boolean | undefined;
        if (horizonDate && projectedGlobalEmailSets) {
          projectedGlobalAttained = unionAttained(req, projectedGlobalEmailSets);
          projectedAttained = hasTrainingTitle ? projectedGlobalAttained : projectedCompliantTheatreCount;
          projectedTheatreBreakdown = null;
          if (minimumPerTheatre !== null && minimumPerTheatre > 0) {
            projectedTheatreBreakdown = unionAttainedByTheatre(req, projectedByTitleAndTheatre, distinctTheatres).map((t) => ({
              theatre: t.theatre,
              count: t.count,
              compliant: t.count >= minimumPerTheatre,
            }));
          }
          const pPrimaryMet = projectedAttained >= req.quantityRequired;
          const pTheatresMet = projectedTheatreBreakdown === null || projectedTheatreBreakdown.every((t) => t.compliant);
          projectedCompliant = pPrimaryMet && pTheatresMet;
        }

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
          projectedAttained,
          projectedGlobalAttained,
          projectedTheatreBreakdown,
          projectedCompliant,
          alternatives: req.alternatives.map((a: ProgramDataRow["alternatives"][number]) => ({
            trainingType: a.trainingType,
            trainingTitle: a.trainingTitle,
            trainingFullTitle: a.trainingData?.fullTitle ?? "—",
          })),
        };
      });

      const specCompliant = specReqs.every((r) => r.compliant);
      const projectedSpecCompliant = horizonDate
        ? specReqs.every((r) => r.projectedCompliant)
        : undefined;
      globalSpecialisations.push({
        name: specName,
        compliant: specCompliant,
        projectedCompliant: projectedSpecCompliant,
        requirements: specReqs,
      });
    }

    const tiers = isTiered
      ? await computeTierBlock({
          levelName: "Global",
          scope: { companyIds: companyFilter },
          useTheatre: meta.hasMinimumPerTheatre,
          theatres: distinctTheatres,
          companyFilter,
          rows: programData,
          tiers: tierRows,
          deploymentMode,
          now,
          horizonDate,
        })
      : undefined;

    return NextResponse.json({
      specialisations: globalSpecialisations,
      countries,
      regions: regionList,
      theatres: theatreList,
      meta,
      horizonMonths,
      tiers,
    });
  }

  const specialisations = buildSpecialisations(specMap, "Country", new Map(), null);
  return NextResponse.json({ specialisations, countries, regions: regionList, theatres: theatreList, meta, horizonMonths });
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
  emailSets: Map<string, Set<string>>,
  projectedEmailSets: Map<string, Set<string>> | null
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
        projectedAttained:
          projectedEmailSets && req.trainingTitle
            ? unionAttained(req, projectedEmailSets)
            : undefined,
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

interface TierBlockRow {
  id: number;
  specialisationId: number | null;
  tierId: number | null;
  purpose: string;
  level: string;
  trainingType: string | null;
  trainingTitle: string | null;
  quantityRequired: number;
  minimumPerTheatre: number | null;
  specialisation: { name: string } | null;
  trainingData: { fullTitle: string } | null;
  alternatives: { trainingType: string; trainingTitle: string; trainingData: { fullTitle: string } | null }[];
}

interface TierBlockTier {
  id: number;
  name: string;
  sortOrder: number;
  specialisationsRequired: number;
}

/**
 * Build the tier-ladder block for a tiered program at a given level + scope.
 * Reuses `evaluateTierLadder` (distinct-people counting) for a "now" snapshot
 * and, when a horizon is set, a forward-looking one. Deployment requirements
 * are sourced by `deploymentMode` (flat = the tier's own rows;
 * perAchievedSpecialisation = each achieved specialisation's deployment rows).
 */
async function computeTierBlock(params: {
  levelName: "Country" | "Theatre" | "Global";
  scope: ComplianceScope;
  useTheatre: boolean;
  theatres: string[];
  companyFilter: number[] | null;
  rows: TierBlockRow[];
  tiers: TierBlockTier[];
  deploymentMode: string;
  now: Date;
  horizonDate: Date | null;
}) {
  const { levelName, scope, useTheatre, theatres, companyFilter, rows, tiers, deploymentMode, now, horizonDate } = params;

  const levelRows = rows.filter((r) => r.level === levelName);

  const requirements = new Map<number, ProgramRequirement>();
  interface DepDisplay {
    trainingType: string | null;
    trainingTitle: string | null;
    trainingFullTitle: string;
    quantityRequired: number;
    minimumPerTheatre: number | null;
    alternatives: { trainingType: string; trainingTitle: string; trainingFullTitle: string }[];
  }
  const display = new Map<number, DepDisplay>();
  for (const r of levelRows) {
    requirements.set(r.id, {
      trainingTitle: r.trainingTitle,
      alternatives: r.alternatives.map((a) => ({ trainingTitle: a.trainingTitle })),
      quantityRequired: r.quantityRequired,
      minimumPerTheatre: r.minimumPerTheatre,
    });
    display.set(r.id, {
      trainingType: r.trainingType,
      trainingTitle: r.trainingTitle,
      trainingFullTitle: r.trainingData?.fullTitle ?? "—",
      quantityRequired: r.quantityRequired,
      minimumPerTheatre: r.minimumPerTheatre ?? null,
      alternatives: r.alternatives.map((a) => ({
        trainingType: a.trainingType,
        trainingTitle: a.trainingTitle,
        trainingFullTitle: a.trainingData?.fullTitle ?? "—",
      })),
    });
  }

  // Split specialisation rows into qualifying vs deployment purpose.
  const specQual = new Map<string, number[]>();
  const specDep = new Map<string, number[]>();
  for (const r of levelRows) {
    if (r.specialisationId == null || !r.specialisation) continue;
    const name = r.specialisation.name;
    const target = r.purpose === "deployment" ? specDep : specQual;
    if (!target.has(name)) target.set(name, []);
    target.get(name)!.push(r.id);
  }
  const specNames = new Set<string>([...specQual.keys(), ...specDep.keys()]);
  const specs = [...specNames].map((name) => ({
    name,
    qualifyingReqIds: specQual.get(name) ?? [],
    deploymentReqIds: specDep.get(name) ?? [],
  }));

  // Tier-scoped deployment rows (flat mode).
  const tierDepIds = new Map<number, number[]>();
  for (const r of levelRows) {
    if (r.tierId == null) continue;
    if (!tierDepIds.has(r.tierId)) tierDepIds.set(r.tierId, []);
    tierDepIds.get(r.tierId)!.push(r.id);
  }

  const tiersInput = tiers.map((t) => ({
    id: t.id,
    name: t.name,
    sortOrder: t.sortOrder,
    specialisationsRequired: t.specialisationsRequired,
    deploymentReqIds: tierDepIds.get(t.id) ?? [],
  }));

  const input: TierLadderInput = { tiers: tiersInput, specs, requirements, deploymentMode };

  const uniqueTitles = [
    ...new Set(
      [...requirements.values()].flatMap((r) => [
        ...(r.trainingTitle ? [r.trainingTitle] : []),
        ...r.alternatives.map((a) => a.trainingTitle),
      ])
    ),
  ];

  const emptyByTheatre = new Map<string, Map<string, Set<string>>>();
  const emailSets = await getEmailSetsByTitle(uniqueTitles, now, scope);
  const byTheatre = useTheatre
    ? await getEmailSetsByTitleAndTheatre(uniqueTitles, now, companyFilter)
    : emptyByTheatre;
  const snapNow = evaluateTierLadder(input, emailSets, byTheatre, theatres);

  let snapProj: ReturnType<typeof evaluateTierLadder> | null = null;
  if (horizonDate) {
    const projEmail = await getEmailSetsByTitle(uniqueTitles, horizonDate, scope);
    const projByTheatre = useTheatre
      ? await getEmailSetsByTitleAndTheatre(uniqueTitles, horizonDate, companyFilter)
      : emptyByTheatre;
    snapProj = evaluateTierLadder(input, projEmail, projByTheatre, theatres);
  }

  const buildDepReq = (id: number, specialisationName: string | null) => {
    const d = display.get(id)!;
    return {
      specialisationName,
      trainingType: d.trainingType,
      trainingTitle: d.trainingTitle,
      trainingFullTitle: d.trainingFullTitle,
      quantityRequired: d.quantityRequired,
      minimumPerTheatre: d.minimumPerTheatre,
      attained: snapNow.reqAttained.get(id) ?? 0,
      compliant: snapNow.reqCompliant.get(id) ?? false,
      theatreBreakdown: snapNow.reqTheatreBreakdown.get(id) ?? null,
      projectedAttained: snapProj ? snapProj.reqAttained.get(id) ?? 0 : null,
      projectedCompliant: snapProj ? snapProj.reqCompliant.get(id) ?? false : null,
      projectedTheatreBreakdown: snapProj ? snapProj.reqTheatreBreakdown.get(id) ?? null : null,
      alternatives: d.alternatives,
    };
  };

  const outTiers = tiersInput.map((t) => {
    let deploymentRequirements: ReturnType<typeof buildDepReq>[];
    if (deploymentMode === "perAchievedSpecialisation") {
      deploymentRequirements = [];
      for (const name of [...snapNow.achievedSpecs].sort()) {
        for (const id of specDep.get(name) ?? []) deploymentRequirements.push(buildDepReq(id, name));
      }
    } else {
      deploymentRequirements = (tierDepIds.get(t.id) ?? []).map((id) => buildDepReq(id, null));
    }
    return {
      name: t.name,
      sortOrder: t.sortOrder,
      specialisationsRequired: t.specialisationsRequired,
      compliant: snapNow.tierCompliant.get(t.id) ?? false,
      projectedCompliant: snapProj ? snapProj.tierCompliant.get(t.id) ?? false : null,
      deploymentRequirements,
    };
  });

  const nameOf = (id: number | null) => (id == null ? null : tiers.find((t) => t.id === id)?.name ?? null);

  return {
    deploymentMode,
    highestAchievedTier: nameOf(snapNow.highestAchievedTierId),
    projectedHighestAchievedTier: snapProj ? nameOf(snapProj.highestAchievedTierId) : null,
    achievedSpecialisations: [...snapNow.achievedSpecs].sort(),
    achievedSpecialisationCount: snapNow.achievedSpecCount,
    projectedAchievedSpecialisationCount: snapProj ? snapProj.achievedSpecCount : null,
    tiers: outTiers,
  };
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
