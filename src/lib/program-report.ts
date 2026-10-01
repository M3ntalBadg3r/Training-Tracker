import prisma from "@/lib/prisma";
import { addMonths } from "@/lib/utils";
import {
  countriesInRegion,
  extractTitles,
  getEmailSetsByTitle,
  getEmailSetsByTitleAndTheatre,
  listTheatres,
  resolveSiblingTitles,
  unionAttained,
  unionAttainedByTheatre,
  evaluateTierLadder,
  buildCountryBucketContext,
  requirementCompliant,
  type ComplianceScope,
  type CountryBucketContext,
  type ProgramRequirement,
  type TierLadderInput,
} from "@/lib/program-compliance";
import { countriesInCountrySet, listCountrySetNames } from "@/lib/country-sets";
import {
  normaliseAggregation,
  type Aggregation,
  type CountryBreakdownRow,
  type ReqLevel,
} from "@/lib/program-levels";
import {
  buildTrainedNotCertifiedContext,
  getTrainedNotCertifiedRoster,
  isTncRequirement,
  trainedNotCertifiedEmails,
  type TrainedNotCertifiedContext,
} from "@/lib/program-trained-not-certified";

/**
 * Shared, presentation-agnostic builders for the data-driven program compliance
 * report. The internal (JWT) route `/api/programs/[programName]` and the public
 * (API-key) route `/api/public/v1/programs/[programName]` both call these — the
 * only difference between the two callers is how they resolve the company scope
 * (`companyIds`): the internal route derives it from the session, the public one
 * from the API key. `companyIds === null` means unrestricted; an empty array
 * means no accessible companies (the callers short-circuit before calling here).
 */

export interface BuildProgramReportOptions {
  programName: string;
  /** "country" | "region" | "countrySet" | "theatre" | "global" (anything else → empty spec list). */
  level: string;
  country: string;
  region: string;
  /**
   * Country Set name, used when level is "countrySet". Resolved within the
   * single company `companyIds` names — a set is per-company tenant data.
   */
  countrySet?: string;
  theatre: string;
  /** Already validated to one of 0 | 3 | 6 | 12. */
  horizonMonths: number;
  companyIds: number[] | null;
}

/**
 * Build the full compliance payload for one program at the requested level +
 * scope. Returns the same object shape the program dashboard consumes:
 * `{ specialisations, countries, regions, theatres, countrySets, meta, horizonMonths, tiers? }`.
 *
 * Each view reads only its own level's rows (`program-levels.ts:SCOPE_TO_REQ_LEVEL`):
 * country → Country rows over that country; region → Region rows over the
 * region's countries; countrySet → CountrySet rows over the set's countries;
 * theatre → Theatre rows; global → Global rows. "By Region" used to pool the
 * Country rows across the region's countries — that derivation is gone.
 */
export async function buildProgramReport(opts: BuildProgramReportOptions) {
  const { programName, level, country, region, theatre, horizonMonths, companyIds } = opts;
  const countrySet = opts.countrySet ?? "";

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
    return {
      specialisations: [],
      countries: [],
      regions: [],
      theatres: [],
      countrySets: [] as string[],
      meta,
      horizonMonths,
    };
  }

  // Deliberately unscoped, and the asymmetry with the scoped `listTheatres` and
  // `listCountrySetNames` calls below is intentional rather than an oversight.
  //
  // `RegionData` is a global, admin-curated reference table (country → region →
  // theatre) with no `companyId` — there is no tenant dimension to filter on.
  // It carries no student, completion or company data, so reading it in full
  // discloses nothing about another tenant. `listTheatres` is scoped because it
  // derives its list from `Student` rows, which ARE tenant data.
  //
  // Scoping this would also be wrong on its own terms: the country/region lists
  // populate the dashboard's geography pickers, so narrowing them to countries
  // that happen to have an in-scope student would silently drop legitimately
  // empty geographies a partner is expected to plan against.
  const regionData = await prisma.regionData.findMany({ orderBy: { country: "asc" } });
  const countries = regionData.map((r: typeof regionData[number]) => r.country);
  const regionList = [...new Set(regionData.map((r: typeof regionData[number]) => r.region))].filter(Boolean).sort();
  const theatreList = await listTheatres(companyIds);
  // Country Sets, unlike RegionData, ARE tenant data: each belongs to one
  // company and names are unique only per company, so two partners can each own
  // a "Set 1" over different countries. The list is therefore scoped — it holds
  // the scoped company's own non-empty sets, and is `[]` unless `companyIds` is
  // exactly one company (`listCountrySetNames` enforces that), so an ambiguous
  // scope neither offers a picker nor discloses another company's set names.
  const countrySetList = await listCountrySetNames(companyIds);
  const lists = { countries, regions: regionList, theatres: theatreList, countrySets: countrySetList };

  // `specMap` holds the qualifying, specialisation-scoped rows (these define
  // whether a specialisation is *achieved*). `specDepMap` holds that
  // specialisation's deployment-purpose rows: they do NOT affect achievement,
  // but a tier that uses the specialisation requires them too, so the level
  // reports surface them alongside the qualifying requirements. Tier-scoped rows
  // (tierId set — whether or not they also carry a specialisationId, as in
  // "perTierPerSpecialisation" mode) remain the tier ladder's concern.
  const specMap = new Map<string, ProgramDataRow[]>();
  const specDepMap = new Map<string, ProgramDataRow[]>();
  for (const pd of programData) {
    if (pd.specialisationId == null || !pd.specialisation || pd.tierId != null) continue;
    const key = pd.specialisation.name;
    const target = pd.purpose === "deployment" ? specDepMap : specMap;
    if (!target.has(key)) target.set(key, []);
    target.get(key)!.push(pd);
  }

  const now = new Date();
  const horizonDate = horizonMonths > 0 ? addMonths(now, horizonMonths) : null;

  // The specialisation-table rows authored at one level — the rows the
  // "Trained not certified" figure is computed for (Tier Status is excluded).
  const specTableRows = (reqLevel: ReqLevel) =>
    [...specMap.values(), ...specDepMap.values()].flat().filter((r) => r.level === reqLevel);

  if (level === "country" && country) {
    const countryReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Country");
    const titles = extractTitles(countryReqs);
    const scope: ComplianceScope = { country, companyIds };
    const emailSets = await getEmailSetsByTitle(titles, now, scope);
    const projectedEmailSets = horizonDate
      ? await getEmailSetsByTitle(titles, horizonDate, scope)
      : null;
    const tnc = await buildTrainedNotCertifiedContext(specTableRows("Country"), now, scope);
    const specialisations = buildSpecialisations(specMap, specDepMap, "Country", emailSets, projectedEmailSets, null, tnc);
    const tiers = isTiered
      ? await computeTierBlock({ levelName: "Country", scope, useTheatre: false, theatres: [], companyIds, rows: programData, tiers: tierRows, deploymentMode, now, horizonDate, countryCtx: null })
      : undefined;
    return { specialisations, ...lists, meta, horizonMonths, tiers };
  }

  // Region and Country Set share one multi-country path: the area is a list of
  // countries (the region's, or the set's), the rows are that level's own, and a
  // row's `aggregation` decides whether it is pooled across the area ("total")
  // or must be met in every one of its countries ("eachCountry").
  //
  // The set is resolved within the single scoped company. The routes refuse a
  // `level=countrySet` request whose scope is not exactly one company (400,
  // `COUNTRY_SET_SCOPE_ERROR`); should a caller skip that, `countriesInCountrySet`
  // answers `[]` for an ambiguous scope, which reads as an empty, never-compliant
  // area — never as two companies' same-named sets merged into one.
  const multi =
    level === "region" && region
      ? { reqLevel: "Region" as const, countries: await countriesInRegion(region) }
      : level === "countrySet" && countrySet
        ? { reqLevel: "CountrySet" as const, countries: await countriesInCountrySet(countrySet, companyIds) }
        : null;
  if (multi) {
    const levelRows = programData.filter((pd: ProgramDataRow) => pd.level === multi.reqLevel);
    const titles = extractTitles(levelRows);
    const areaCountries = multi.countries;
    const scope: ComplianceScope = { countries: areaCountries, companyIds };
    // An empty area (an unknown region, a set whose countries were all deleted)
    // gives a clean non-compliant report rather than a query: `countries: []`
    // would match nothing anyway, so skip the round-trip.
    const hasArea = areaCountries.length > 0;
    const emailSets = hasArea
      ? await getEmailSetsByTitle(titles, now, scope)
      : new Map<string, Set<string>>();
    const projectedEmailSets = horizonDate
      ? hasArea
        ? await getEmailSetsByTitle(titles, horizonDate, scope)
        : new Map<string, Set<string>>()
      : null;
    // The per-country buckets are only needed — and only fetched — when some
    // in-scope row is "eachCountry": one bucketed query per as-of date over just
    // those rows' titles, never a query per country.
    const eachCountryTitles = extractTitles(
      levelRows.filter((pd: ProgramDataRow) => normaliseAggregation(pd.level, pd.aggregation) === "eachCountry")
    );
    const countryCtx: CountryCtxPair | null =
      eachCountryTitles.length > 0
        ? {
            now: await buildCountryBucketContext(eachCountryTitles, now, areaCountries, companyIds),
            projected: horizonDate
              ? await buildCountryBucketContext(eachCountryTitles, horizonDate, areaCountries, companyIds)
              : null,
          }
        : null;
    const tnc = await buildTrainedNotCertifiedContext(specTableRows(multi.reqLevel), now, scope, hasArea);
    const specialisations = buildSpecialisations(specMap, specDepMap, multi.reqLevel, emailSets, projectedEmailSets, countryCtx, tnc);
    const tiers = isTiered
      ? await computeTierBlock({ levelName: multi.reqLevel, scope, useTheatre: false, theatres: [], companyIds, rows: programData, tiers: tierRows, deploymentMode, now, horizonDate, countryCtx })
      : undefined;
    return { specialisations, ...lists, meta, horizonMonths, tiers };
  }

  if (level === "theatre" && theatre) {
    const theatreReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Theatre");
    const titles = extractTitles(theatreReqs);
    const scope: ComplianceScope = { theatre, companyIds };
    const emailSets = await getEmailSetsByTitle(titles, now, scope);
    const projectedEmailSets = horizonDate
      ? await getEmailSetsByTitle(titles, horizonDate, scope)
      : null;
    const tnc = await buildTrainedNotCertifiedContext(specTableRows("Theatre"), now, scope);
    const specialisations = buildSpecialisations(specMap, specDepMap, "Theatre", emailSets, projectedEmailSets, null, tnc);
    const tiers = isTiered
      ? await computeTierBlock({ levelName: "Theatre", scope, useTheatre: false, theatres: [], companyIds, rows: programData, tiers: tierRows, deploymentMode, now, horizonDate, countryCtx: null })
      : undefined;
    return { specialisations, ...lists, meta, horizonMonths, tiers };
  }

  if (level === "global") {
    const distinctTheatres = theatreList;

    // Global counts + per-theatre breakdown are needed for Global-level
    // requirements that carry a real training title / per-theatre minimum.
    const allTitles = extractTitles(programData);
    const globalEmailSets = await getEmailSetsByTitle(allTitles, now, { companyIds });
    const byTitleAndTheatre = meta.hasMinimumPerTheatre
      ? await getEmailSetsByTitleAndTheatre(allTitles, now, companyIds)
      : new Map<string, Map<string, Set<string>>>();

    // Projected (forward-looking) variants, computed once when a horizon is set.
    const projectedGlobalEmailSets = horizonDate
      ? await getEmailSetsByTitle(allTitles, horizonDate, { companyIds })
      : null;
    const projectedByTitleAndTheatre = horizonDate && meta.hasMinimumPerTheatre
      ? await getEmailSetsByTitleAndTheatre(allTitles, horizonDate, companyIds)
      : new Map<string, Map<string, Set<string>>>();

    // Per-theatre email sets for every theatre-level requirement title across all
    // specialisations, fetched once per as-of date. This replaces the old
    // per-theatre-per-spec getEmailSetsByTitle loop (O(specs × theatres) queries)
    // with two grouped queries (now + horizon). Each title is keyed independently
    // by getEmailSetsByTitleAndTheatre, so batching all specs' titles together
    // yields the same per-title sets a single-spec fetch would.
    const allTheatreReqTitles = extractTitles(
      [...specMap.values()].flatMap((reqs) =>
        reqs.filter((r: ProgramDataRow) => r.level === "Theatre" && r.trainingTitle !== null)
      )
    );
    const theatreByTitleAndTheatre = allTheatreReqTitles.length > 0
      ? await getEmailSetsByTitleAndTheatre(allTheatreReqTitles, now, companyIds)
      : new Map<string, Map<string, Set<string>>>();
    const projectedTheatreByTitleAndTheatre = horizonDate && allTheatreReqTitles.length > 0
      ? await getEmailSetsByTitleAndTheatre(allTheatreReqTitles, horizonDate, companyIds)
      : new Map<string, Map<string, Set<string>>>();

    // Count of compliant theatres for a given snapshot — a theatre is compliant
    // when it meets every theatre-level requirement. Pure: reads the pre-fetched
    // per-theatre email sets instead of querying per theatre.
    // `unionAttainedByTheatre(req, map, [t])` reproduces the old
    // `unionAttained(req, getEmailSetsByTitle(titles, asOf, { theatre: t }))`.
    function countCompliantTheatres(
      theatreReqs: ProgramDataRow[],
      byTitleAndTheatre: Map<string, Map<string, Set<string>>>
    ): number {
      if (theatreReqs.length === 0) return 0;
      let count = 0;
      for (const t of distinctTheatres) {
        const allMet = theatreReqs.every((req: ProgramDataRow) => {
          if (!req.trainingTitle) return false;
          const attained = unionAttainedByTheatre(req, byTitleAndTheatre, [t])[0]?.count ?? 0;
          return attained >= req.quantityRequired;
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

      const compliantTheatreCount = countCompliantTheatres(theatreReqs, theatreByTitleAndTheatre);
      const projectedCompliantTheatreCount = horizonDate
        ? countCompliantTheatres(theatreReqs, projectedTheatreByTitleAndTheatre)
        : 0;

      const buildGlobalReqDisplay = (req: ProgramDataRow) => {
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
        // student count; for the theatre-compliance placeholder (a Global row
        // naming no training) it's the number of compliant theatres.
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
          // A Global row is always pooled — "eachCountry" is only meaningful on
          // a multi-country level, and normaliseAggregation forces it off here.
          aggregation: "total" as Aggregation,
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
      };

      const specReqs = globalReqs.map(buildGlobalReqDisplay);

      // Deployment-purpose requirements for this specialisation at the Global
      // level — surfaced alongside the qualifying ones (they don't gate the
      // specialisation's own compliance, but a tier that uses it needs them).
      const depGlobalReqs = (specDepMap.get(specName) ?? []).filter((r) => r.level === "Global");
      const deploymentRequirements = depGlobalReqs.map(buildGlobalReqDisplay);
      const deploymentCompliant =
        deploymentRequirements.length > 0
          ? deploymentRequirements.every((r) => r.compliant)
          : undefined;
      const projectedDeploymentCompliant =
        horizonDate && deploymentRequirements.length > 0
          ? deploymentRequirements.every((r) => r.projectedCompliant)
          : undefined;

      const specCompliant = specReqs.every((r) => r.compliant);
      const projectedSpecCompliant = horizonDate
        ? specReqs.every((r) => r.projectedCompliant)
        : undefined;
      globalSpecialisations.push({
        name: specName,
        compliant: specCompliant,
        projectedCompliant: projectedSpecCompliant,
        requirements: specReqs,
        deploymentRequirements,
        deploymentCompliant,
        projectedDeploymentCompliant,
      });
    }

    const tiers = isTiered
      ? await computeTierBlock({
          levelName: "Global",
          scope: { companyIds },
          useTheatre: meta.hasMinimumPerTheatre,
          theatres: distinctTheatres,
          companyIds,
          rows: programData,
          tiers: tierRows,
          deploymentMode,
          now,
          horizonDate,
          countryCtx: null,
        })
      : undefined;

    return {
      specialisations: globalSpecialisations,
      ...lists,
      meta,
      horizonMonths,
      tiers,
    };
  }

  const specialisations = buildSpecialisations(specMap, specDepMap, "Country", new Map(), null, null, null);
  return { specialisations, ...lists, meta, horizonMonths };
}

/** The "now" and (when a horizon is set) projected per-country contexts. */
interface CountryCtxPair {
  now: CountryBucketContext;
  projected: CountryBucketContext | null;
}

/** Distinct countries meeting the quantity, from a breakdown. */
function countriesMetOf(breakdown: CountryBreakdownRow[]): number {
  return breakdown.filter((c) => c.compliant).length;
}

type SpecReqRow = {
  level: string;
  aggregation: string;
  trainingType: string | null;
  trainingTitle: string | null;
  trainingData: { fullTitle: string } | null;
  quantityRequired: number;
  alternatives: Array<{
    trainingType: string;
    trainingTitle: string;
    trainingData: { fullTitle: string } | null;
  }>;
};

/**
 * The per-level specialisation report for every level except Global (which has
 * its own card/theatre-count shapes above).
 *
 * Every requirement carries `aggregation`, `compliant` and — only when a horizon
 * is set — `projectedCompliant`, and every specialisation carries
 * `compliant`/`projectedCompliant` (all its qualifying requirements compliant).
 *
 * An `"eachCountry"` row additionally carries the per-country figures. Its
 * `attained`/`projectedAttained` are the LOWEST per-country count, so the
 * client's `riskState(attained, projected, required)` and every export that
 * reads `attained >= quantityRequired` stay correct unchanged; the pooled
 * distinct-holder count moves to `pooledAttained`.
 *
 * With a `tnc` context, every Certification requirement also carries
 * `trainedNotCertified`: the people in the same population holding an active
 * ILT/OLX that leads to it but not the certification itself (the rule is in
 * `lib/program-trained-not-certified.ts`). It is always today's figure, even
 * under a horizon, and absent on every other row. For an `"eachCountry"` row it
 * is the area total, because `emailSets` is the pooled area map.
 */
function buildSpecialisations(
  specMap: Map<string, SpecReqRow[]>,
  specDepMap: Map<string, SpecReqRow[]>,
  level: ReqLevel,
  emailSets: Map<string, Set<string>>,
  projectedEmailSets: Map<string, Set<string>> | null,
  countryCtx: CountryCtxPair | null,
  tnc: TrainedNotCertifiedContext | null
) {
  const mapReq = (req: SpecReqRow) => {
    const aggregation = normaliseAggregation(req.level, req.aggregation);
    const common = {
      trainingType: req.trainingType ?? null,
      trainingTitle: req.trainingTitle ?? null,
      trainingFullTitle: req.trainingData?.fullTitle ?? "—",
      quantityRequired: req.quantityRequired,
      aggregation,
      // Spread rather than assigned, so the key is genuinely absent (not
      // `undefined`) on a row the figure does not apply to.
      ...(tnc && isTncRequirement(req)
        ? { trainedNotCertified: trainedNotCertifiedEmails(req, tnc, emailSets).size }
        : {}),
    };
    const alternatives = req.alternatives.map((a) => ({
      trainingType: a.trainingType,
      trainingTitle: a.trainingTitle,
      trainingFullTitle: a.trainingData?.fullTitle ?? "—",
    }));

    if (aggregation === "eachCountry") {
      const asReq: ProgramRequirement = {
        trainingTitle: req.trainingTitle,
        alternatives: req.alternatives.map((a) => ({ trainingTitle: a.trainingTitle })),
        quantityRequired: req.quantityRequired,
        aggregation,
      };
      // No context means the caller had no area to judge against — the engine
      // fails closed on that, and so does the display (0 of 0 countries met).
      const nowEval = requirementCompliant(asReq, emailSets, undefined, undefined, countryCtx?.now);
      const countryBreakdown = nowEval.countryBreakdown ?? [];
      const projEval = projectedEmailSets
        ? requirementCompliant(asReq, projectedEmailSets, undefined, undefined, countryCtx?.projected ?? undefined)
        : null;
      const projectedCountryBreakdown = projEval ? projEval.countryBreakdown ?? [] : undefined;
      return {
        ...common,
        attained: nowEval.attained,
        projectedAttained: projEval ? projEval.attained : undefined,
        compliant: nowEval.compliant,
        projectedCompliant: projEval ? projEval.compliant : undefined,
        pooledAttained: nowEval.pooledAttained ?? 0,
        projectedPooledAttained: projEval ? projEval.pooledAttained ?? 0 : undefined,
        countriesMet: countriesMetOf(countryBreakdown),
        countriesTotal: countryBreakdown.length,
        projectedCountriesMet: projectedCountryBreakdown ? countriesMetOf(projectedCountryBreakdown) : undefined,
        countryBreakdown,
        projectedCountryBreakdown,
        alternatives,
      };
    }

    const attained = req.trainingTitle ? unionAttained(req, emailSets) : 0;
    const projectedAttained =
      projectedEmailSets && req.trainingTitle ? unionAttained(req, projectedEmailSets) : undefined;
    return {
      ...common,
      attained,
      projectedAttained,
      compliant: attained >= req.quantityRequired,
      projectedCompliant: projectedEmailSets
        ? (projectedAttained ?? attained) >= req.quantityRequired
        : undefined,
      alternatives,
    };
  };

  const result = [];
  for (const [name, reqs] of specMap) {
    const levelReqs = reqs.filter((r) => r.level === level);
    if (levelReqs.length === 0) continue;

    // Deployment-purpose requirements for the same specialisation at this level.
    // They don't change whether the specialisation is achieved (that stays on
    // the qualifying requirements), but a tier that uses the specialisation
    // requires them too, so they're surfaced with their own met/not-met state.
    const depLevelReqs = (specDepMap.get(name) ?? []).filter((r) => r.level === level);
    const deploymentRequirements = depLevelReqs.map(mapReq);
    const deploymentCompliant =
      deploymentRequirements.length > 0
        ? deploymentRequirements.every((r) => r.compliant)
        : undefined;
    const projectedDeploymentCompliant =
      projectedEmailSets && deploymentRequirements.length > 0
        ? deploymentRequirements.every((r) => r.projectedCompliant ?? r.compliant)
        : undefined;

    const requirements = levelReqs.map(mapReq);
    result.push({
      name,
      compliant: requirements.every((r) => r.compliant),
      projectedCompliant: projectedEmailSets
        ? requirements.every((r) => r.projectedCompliant ?? r.compliant)
        : undefined,
      requirements,
      deploymentRequirements,
      deploymentCompliant,
      projectedDeploymentCompliant,
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
  aggregation: string;
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
 *
 * `countryCtx` carries the per-country buckets for a multi-country level's
 * `"eachCountry"` rows (null elsewhere); those rows are judged country by
 * country, so a specialisation needing "4 per country" is achieved — and feeds
 * the tier gate — only when every country in the area has 4.
 */
async function computeTierBlock(params: {
  levelName: ReqLevel;
  scope: ComplianceScope;
  useTheatre: boolean;
  theatres: string[];
  companyIds: number[] | null;
  rows: TierBlockRow[];
  tiers: TierBlockTier[];
  deploymentMode: string;
  now: Date;
  horizonDate: Date | null;
  countryCtx: CountryCtxPair | null;
}) {
  const { levelName, scope, useTheatre, theatres, companyIds, rows, tiers, deploymentMode, now, horizonDate, countryCtx } = params;

  const levelRows = rows.filter((r) => r.level === levelName);

  const requirements = new Map<number, ProgramRequirement>();
  interface DepDisplay {
    trainingType: string | null;
    trainingTitle: string | null;
    trainingFullTitle: string;
    quantityRequired: number;
    minimumPerTheatre: number | null;
    aggregation: Aggregation;
    alternatives: { trainingType: string; trainingTitle: string; trainingFullTitle: string }[];
  }
  const display = new Map<number, DepDisplay>();
  for (const r of levelRows) {
    const aggregation = normaliseAggregation(r.level, r.aggregation);
    requirements.set(r.id, {
      trainingTitle: r.trainingTitle,
      alternatives: r.alternatives.map((a) => ({ trainingTitle: a.trainingTitle })),
      quantityRequired: r.quantityRequired,
      minimumPerTheatre: r.minimumPerTheatre,
      aggregation,
    });
    display.set(r.id, {
      trainingType: r.trainingType,
      trainingTitle: r.trainingTitle,
      trainingFullTitle: r.trainingData?.fullTitle ?? "—",
      quantityRequired: r.quantityRequired,
      minimumPerTheatre: r.minimumPerTheatre ?? null,
      aggregation,
      alternatives: r.alternatives.map((a) => ({
        trainingType: a.trainingType,
        trainingTitle: a.trainingTitle,
        trainingFullTitle: a.trainingData?.fullTitle ?? "—",
      })),
    });
  }

  // Split specialisation-scoped rows (tierId == null) into qualifying vs
  // deployment purpose. Rows that also carry a tierId are per-tier deployment
  // requirements ("perTierPerSpecialisation" mode) handled separately below.
  const specQual = new Map<string, number[]>();
  const specDep = new Map<string, number[]>();
  for (const r of levelRows) {
    if (r.specialisationId == null || !r.specialisation || r.tierId != null) continue;
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

  // Tier-scoped deployment rows: flat mode = tierId only; perTierPerSpecialisation
  // = tierId + specialisationId (grouped by tier, then specialisation name).
  const tierDepIds = new Map<number, number[]>();
  const tierSpecDepIds = new Map<number, Map<string, number[]>>();
  for (const r of levelRows) {
    if (r.tierId == null) continue;
    if (r.specialisationId != null && r.specialisation) {
      const byName = tierSpecDepIds.get(r.tierId) ?? new Map<string, number[]>();
      const list = byName.get(r.specialisation.name) ?? [];
      list.push(r.id);
      byName.set(r.specialisation.name, list);
      tierSpecDepIds.set(r.tierId, byName);
    } else {
      if (!tierDepIds.has(r.tierId)) tierDepIds.set(r.tierId, []);
      tierDepIds.get(r.tierId)!.push(r.id);
    }
  }

  const tiersInput = tiers.map((t) => ({
    id: t.id,
    name: t.name,
    sortOrder: t.sortOrder,
    specialisationsRequired: t.specialisationsRequired,
    deploymentReqIds: tierDepIds.get(t.id) ?? [],
    deploymentReqIdsBySpec: tierSpecDepIds.get(t.id) ?? new Map<string, number[]>(),
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
    ? await getEmailSetsByTitleAndTheatre(uniqueTitles, now, companyIds)
    : emptyByTheatre;
  const snapNow = evaluateTierLadder(input, emailSets, byTheatre, theatres, countryCtx?.now);

  let snapProj: ReturnType<typeof evaluateTierLadder> | null = null;
  if (horizonDate) {
    const projEmail = await getEmailSetsByTitle(uniqueTitles, horizonDate, scope);
    const projByTheatre = useTheatre
      ? await getEmailSetsByTitleAndTheatre(uniqueTitles, horizonDate, companyIds)
      : emptyByTheatre;
    snapProj = evaluateTierLadder(input, projEmail, projByTheatre, theatres, countryCtx?.projected ?? undefined);
  }

  const buildDepReq = (id: number, specialisationName: string | null) => {
    const d = display.get(id)!;
    // The per-country fields are always present on a tier row and null unless
    // the row is "eachCountry" (for which `attained` is the lowest country).
    const isEach = d.aggregation === "eachCountry";
    const countryBreakdown = isEach ? snapNow.reqCountryBreakdown.get(id) ?? [] : null;
    const projectedCountryBreakdown = isEach && snapProj ? snapProj.reqCountryBreakdown.get(id) ?? [] : null;
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
      aggregation: d.aggregation,
      pooledAttained: isEach ? snapNow.reqPooledAttained.get(id) ?? 0 : null,
      projectedPooledAttained: isEach && snapProj ? snapProj.reqPooledAttained.get(id) ?? 0 : null,
      countriesMet: countryBreakdown ? countriesMetOf(countryBreakdown) : null,
      countriesTotal: countryBreakdown ? countryBreakdown.length : null,
      projectedCountriesMet: projectedCountryBreakdown ? countriesMetOf(projectedCountryBreakdown) : null,
      countryBreakdown,
      projectedCountryBreakdown,
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
    } else if (deploymentMode === "perTierPerSpecialisation") {
      deploymentRequirements = [];
      const byName = tierSpecDepIds.get(t.id);
      for (const name of [...snapNow.achievedSpecs].sort()) {
        for (const id of byName?.get(name) ?? []) deploymentRequirements.push(buildDepReq(id, name));
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
      // "perTierPerSpecialisation" only: how many specialisations meet all of the
      // tier's criteria (drives that mode's per-tier count display); null otherwise.
      satisfiedSpecialisationCount: snapNow.tierSatisfiedSpecCount.get(t.id) ?? null,
      projectedSatisfiedSpecialisationCount: snapProj ? snapProj.tierSatisfiedSpecCount.get(t.id) ?? null : null,
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

export interface GetProgramStudentsOptions {
  trainingTitles: string[];
  level: string;
  country: string;
  region: string;
  /** Country Set name, used when level is "countrySet". */
  countrySet?: string;
  theatre: string;
  companyIds: number[] | null;
  /**
   * Return the "Trained not certified" roster for these titles instead of the
   * holder roster: people holding an active ILT/OLX that leads to one of the
   * Certification titles, but none of the titles themselves.
   */
  trainedNotCertified?: boolean;
}

/**
 * The `ComplianceScope` a roster is drawn from — the same one
 * `buildProgramReport` counts the selected level over, so the trained-not-
 * certified list matches its figure exactly. Returns `hasArea: false` for a
 * Region / Country Set view whose area resolves to no countries.
 */
async function resolveRosterScope(
  opts: GetProgramStudentsOptions
): Promise<{ scope: ComplianceScope; hasArea: boolean }> {
  const { level, country, region, theatre, companyIds } = opts;
  const countrySet = opts.countrySet ?? "";
  if (level === "country" && country) return { scope: { country, companyIds }, hasArea: true };
  if (level === "region" && region) {
    const countries = await countriesInRegion(region);
    return { scope: { countries, companyIds }, hasArea: countries.length > 0 };
  }
  if (level === "countrySet" && countrySet) {
    // Fails closed to `[]` on an ambiguous company scope, exactly as below.
    const countries = await countriesInCountrySet(countrySet, companyIds);
    return { scope: { countries, companyIds }, hasArea: countries.length > 0 };
  }
  if (level === "theatre" && theatre) return { scope: { theatre, companyIds }, hasArea: true };
  return { scope: { companyIds }, hasArea: true };
}

/**
 * Roster drill-down: the distinct, currently-active holders of any of the given
 * training titles, scoped to the level selector + companies. Returns the plain
 * object the callers wrap in a JSON response. With `trainedNotCertified`, the
 * roster behind the "Trained not certified" figure instead.
 */
export async function getProgramStudents(opts: GetProgramStudentsOptions) {
  if (opts.trainedNotCertified) {
    const { scope, hasArea } = await resolveRosterScope(opts);
    return getTrainedNotCertifiedRoster(opts.trainingTitles, scope, hasArea);
  }
  const { trainingTitles, level, country, region, theatre, companyIds } = opts;
  const countrySet = opts.countrySet ?? "";
  const now = new Date();

  const studentFilter: Record<string, unknown> = {};
  if (level === "country" && country) {
    studentFilter.country = country;
  } else if (level === "region" && region) {
    const regionCountries = await countriesInRegion(region);
    studentFilter.country = { in: regionCountries };
  } else if (level === "countrySet" && countrySet) {
    // An unknown or empty set resolves to `[]`, and `in: []` matches nobody —
    // the honest roster for an area with no countries. The same holds for a
    // scope that is not exactly one company: a set name only resolves within
    // one company, so `countriesInCountrySet` answers `[]` and the roster fails
    // closed rather than merging two companies' same-named sets. (The routes
    // 400 such a request first; this keeps the helper safe on its own.)
    studentFilter.country = { in: await countriesInCountrySet(countrySet, companyIds) };
  } else if (level === "theatre" && theatre) {
    studentFilter.theatre = theatre;
  }
  // Empty array = "no accessible companies", which must match nothing. Testing
  // `length > 0` dropped the filter and returned every company's holders.
  // `null` stays the deliberate "unrestricted" case; `[]` is truthy and yields
  // `in: []`. The callers short-circuit on an empty scope today (see the note
  // on BuildProgramReportOptions.companyIds), but this no longer relies on it.
  if (companyIds) {
    studentFilter.companyId = { in: companyIds };
  }

  // Expand each requested title to its fullTitle+type sibling group so the roster
  // matches the attained count (which unions sibling variants via
  // getEmailSetsByTitle). Without this, holders of a sibling variant of the
  // primary or an alternative are counted but missing from the View list.
  const { fetchTitles } = await resolveSiblingTitles(trainingTitles);

  const records = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: fetchTitles },
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

  return { students };
}
