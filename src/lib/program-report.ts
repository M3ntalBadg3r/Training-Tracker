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
import { countriesInCountrySet, listCountrySetNames, singleCompanyId } from "@/lib/country-sets";
import { toRosterRows } from "@/lib/program-roster";
import {
  isProgramWideRow,
  normaliseAggregation,
  theatreViewPopulationOf,
  NO_TARGET_SET_LABEL,
  type Aggregation,
  type CountryBreakdownRow,
  type CountrySetMinimumMeta,
  type MinimumCountriesGate,
  type PopulationKind,
  type ReqLevel,
  type TargetCountriesMeta,
} from "@/lib/program-levels";
import {
  getProgramTerms,
  programHasTargetCountryRows,
  resolveCountrySetMinimum,
  resolveTargetArea,
  type ProgramTermsRow,
  type TargetArea,
} from "@/lib/program-target-countries";
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
   * Country Set name. On level "countrySet" it is the set viewed (blank = the
   * partner's configured Country Set-view set); on level "theatre" of a program
   * with TargetCountries rows it is the set holding the partner's target
   * countries (blank = the partner's configured Theatre-view set). Resolved
   * within the single company `companyIds` names — a set is per-company tenant
   * data.
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
 * Each view reads only its own levels' rows (`program-levels.ts:SCOPE_REQ_LEVELS`):
 * country → Country rows over that country; region → Region rows over the
 * region's countries; countrySet → CountrySet rows over the set's countries
 * (plus the partner's Country Set minimum); theatre → Theatre rows over the
 * theatre and, when the program has any, TargetCountries rows over the
 * partner's target countries inside it (`buildTheatreTargetReport`); global →
 * Global rows. "By Region" used to pool the Country rows across the region's
 * countries — that derivation is gone.
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
    const [emailSets, projectedEmailSets, tnc] = await Promise.all([
      getEmailSetsByTitle(titles, now, scope),
      horizonDate ? getEmailSetsByTitle(titles, horizonDate, scope) : null,
      buildTrainedNotCertifiedContext(specTableRows("Country"), now, scope),
    ]);
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
  // The set is resolved within the single scoped company, defaulting to the
  // partner's configured Country Set-view set when none is named. The routes
  // refuse a `level=countrySet` request whose scope is not exactly one company
  // (400, `COUNTRY_SET_SCOPE_ERROR`); should a caller skip that, this fails
  // closed to an empty report — never two companies' same-named sets merged
  // into one. With no set at all (none named, none configured) the area is
  // empty and every row is unmet, as for an unknown set.
  //
  // The Country Set view also carries the partner's **minimum number of
  // countries** in the set: unmet, it blocks every tier (now and projected) —
  // it does not change whether a specialisation is achieved.
  let countrySetView: CountrySetView | null = null;
  let multi: { reqLevel: "Region" | "CountrySet"; countries: string[] } | null = null;
  if (level === "region" && region) {
    multi = { reqLevel: "Region", countries: await countriesInRegion(region) };
  } else if (level === "countrySet") {
    countrySetView = await resolveCountrySetView(program, countrySet, companyIds);
    if (!countrySetView) return { specialisations: [], ...lists, meta, horizonMonths };
    multi = { reqLevel: "CountrySet", countries: countrySetView.meta.countries };
  }
  if (multi) {
    const levelRows = programData.filter((pd: ProgramDataRow) => pd.level === multi.reqLevel);
    const titles = extractTitles(levelRows);
    const areaCountries = multi.countries;
    const scope: ComplianceScope = { countries: areaCountries, companyIds };
    // An empty area (an unknown region, a set whose countries were all deleted)
    // gives a clean non-compliant report rather than a query: `countries: []`
    // would match nothing anyway, so skip the round-trip.
    const hasArea = areaCountries.length > 0;
    const [emailSets, projectedEmailSets, tnc] = await Promise.all([
      hasArea ? getEmailSetsByTitle(titles, now, scope) : new Map<string, Set<string>>(),
      horizonDate
        ? hasArea
          ? getEmailSetsByTitle(titles, horizonDate, scope)
          : new Map<string, Set<string>>()
        : null,
      buildTrainedNotCertifiedContext(specTableRows(multi.reqLevel), now, scope, hasArea),
    ]);
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
    const specialisations = buildSpecialisations(specMap, specDepMap, multi.reqLevel, emailSets, projectedEmailSets, countryCtx, tnc);
    const tiers = isTiered
      ? await computeTierBlock({
          levelName: multi.reqLevel, scope, useTheatre: false, theatres: [], companyIds, rows: programData, tiers: tierRows,
          deploymentMode, now, horizonDate, countryCtx,
          blocked: countrySetView ? !countrySetView.meta.minimumMet : false,
          minimumCountriesGate: countrySetView ? countrySetView.gate : null,
        })
      : undefined;
    return {
      specialisations,
      ...lists,
      meta: countrySetView ? { ...meta, countrySetMinimum: countrySetView.meta } : meta,
      horizonMonths,
      tiers,
    };
  }

  // A program with TargetCountries rows judges its Theatre view over two
  // populations (the theatre, and the partner's target countries inside it);
  // without any, By Theatre is exactly the single-level path below.
  if (level === "theatre" && theatre && programData.some((pd: ProgramDataRow) => pd.level === "TargetCountries")) {
    return buildTheatreTargetReport({
      program,
      theatre,
      programData,
      tierRows,
      specMap,
      specDepMap,
      lists,
      meta,
      horizonMonths,
      isTiered,
      deploymentMode,
      companyIds,
      countrySet,
      now,
      horizonDate,
    });
  }

  if (level === "theatre" && theatre) {
    const theatreReqs = programData.filter((pd: ProgramDataRow) => pd.level === "Theatre");
    const titles = extractTitles(theatreReqs);
    const scope: ComplianceScope = { theatre, companyIds };
    const [emailSets, projectedEmailSets, tnc] = await Promise.all([
      getEmailSetsByTitle(titles, now, scope),
      horizonDate ? getEmailSetsByTitle(titles, horizonDate, scope) : null,
      buildTrainedNotCertifiedContext(specTableRows("Theatre"), now, scope),
    ]);
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

/** A By Country Set view's resolved set, the partner's minimum, and the gate the tiers block carries. */
interface CountrySetView {
  meta: CountrySetMinimumMeta;
  gate: MinimumCountriesGate;
}

/**
 * Resolve a By Country Set view: the set named, else the partner's configured
 * Country Set-view set, its members, and the partner's minimum. `null` when the
 * scope is not exactly one company (fail closed — the routes 400 first).
 *
 * A legacy program with requirement rows but no `Program` row has no terms to
 * read: it gets the named set's members and no minimum.
 */
async function resolveCountrySetView(
  program: ProgramTermsRow | null,
  countrySet: string,
  companyIds: number[] | null
): Promise<CountrySetView | null> {
  let meta: CountrySetMinimumMeta;
  if (program) {
    const resolved = await resolveCountrySetMinimum({ program, countrySet, companyIds });
    if ("error" in resolved) return null;
    meta = resolved.meta;
  } else {
    if (singleCompanyId(companyIds) === null) return null;
    const name = countrySet.trim() || null;
    meta = {
      countrySet: name,
      countries: name ? await countriesInCountrySet(name, companyIds) : [],
      minimumCountries: null,
      minimumCountriesSource: "none",
      minimumMet: true,
    };
  }
  return {
    meta,
    gate: {
      view: "countrySet",
      required: meta.minimumCountries,
      counted: meta.countries.length,
      met: meta.minimumMet,
      source: meta.minimumCountriesSource,
    },
  };
}

/**
 * The key prefixes a By Theatre view's two populations are merged under, so one
 * holder-set map can serve `evaluateTierLadder` while a title used at both
 * levels stays two separate counts.
 */
const POPULATION_KEY: Record<PopulationKind, string> = {
  theatre: "theatre",
  targetCountries: "targets",
};

function prefixKeys<T>(prefix: string, map: Map<string, T>, into: Map<string, T>): Map<string, T> {
  for (const [k, v] of map) into.set(`${prefix}::${k}`, v);
  return into;
}

/** Prefix a target-countries bucket context's title keys for the merged tier evaluation. */
function prefixCountryCtx(ctx: CountryBucketContext | null): CountryBucketContext | undefined {
  if (!ctx) return undefined;
  return {
    countries: ctx.countries,
    byTitleAndCountry: prefixKeys(POPULATION_KEY.targetCountries, ctx.byTitleAndCountry, new Map()),
  };
}

/** The display label of a target-countries population with no set to name. */
const TARGET_COUNTRIES_LABEL = NO_TARGET_SET_LABEL;

/**
 * The **By Theatre** view of a program with TargetCountries rows: one report
 * over two populations, resolved by `program-target-countries.ts`.
 *
 *  - **Theatre** rows are counted over the viewed theatre (`area.theatreScope`).
 *  - **TargetCountries** rows are counted over the partner's **target
 *    countries** — the chosen (or configured Theatre-view) set's members inside
 *    the viewed theatre (`area.targetScope`); an `"eachCountry"` row is judged
 *    in every one of them, with ONE bucketed query per as-of date
 *    (`buildCountryBucketContext`), and fails closed over an empty list.
 *  - Rows at any other level belong to other views and are not evaluated here.
 *
 * Any theatre may be viewed: a theatre holding none of the set's countries has
 * no target countries, which is a minimum shortfall when a minimum applies.
 *
 * The specialisation tables give each row its own population's sets; the tier
 * block merges the two populations' sets under `theatre::` / `targets::` key
 * prefixes and rewrites each requirement's titles to match (see
 * `evaluateTierBlock`), so `evaluateTierLadder`, `isSpecialisationAchieved` and
 * `requirementCompliant` are reused unchanged and a title used at both levels
 * is counted separately over each population. Every requirement row carries
 * `population` + `populationLabel`. Program-wide gates at either level are
 * required by every tier.
 *
 * **Minimum countries**: when the partner names fewer target countries than its
 * Theatre-view minimum (`meta.targetCountries.minimumMet === false`), every tier
 * is unreached, now and at the horizon — fail closed. Specialisation
 * achievement is not affected.
 *
 * Single-company only: `resolveTargetArea` answers `{error: "scope"}`
 * otherwise, which the routes turn into a 400 first; here it fails closed to an
 * empty report (as it does for a program with no `Program` row).
 */
async function buildTheatreTargetReport<Row extends SpecReqRow & TierBlockRow, Meta extends object, Lists extends object>(p: {
  program: ProgramTermsRow | null;
  theatre: string;
  programData: Row[];
  tierRows: TierBlockTier[];
  specMap: Map<string, SpecReqRow[]>;
  specDepMap: Map<string, SpecReqRow[]>;
  lists: Lists;
  meta: Meta;
  horizonMonths: number;
  isTiered: boolean;
  deploymentMode: string;
  companyIds: number[] | null;
  countrySet: string;
  now: Date;
  horizonDate: Date | null;
}) {
  const { programData, specMap, specDepMap, lists, horizonMonths, now, horizonDate } = p;

  const area: TargetArea | { error: "scope" } | null = p.program
    ? await resolveTargetArea({ program: p.program, theatre: p.theatre, countrySet: p.countrySet, companyIds: p.companyIds })
    : null;
  if (!area || "error" in area) {
    return { specialisations: [], ...lists, meta: p.meta, horizonMonths };
  }

  const labelOf = (pop: PopulationKind): PopulationLabel => ({
    population: pop,
    populationLabel: pop === "theatre" ? area.meta.theatre : area.meta.countrySet ?? TARGET_COUNTRIES_LABEL,
  });

  const evaluated = programData.filter((r) => theatreViewPopulationOf(r.level) !== null);
  const theatreRows = evaluated.filter((r) => theatreViewPopulationOf(r.level) === "theatre");
  const targetRows = evaluated.filter((r) => theatreViewPopulationOf(r.level) === "targetCountries");
  const hasTargets = area.meta.targetCountries.length > 0;
  const theatreTitles = extractTitles(theatreRows);
  const targetTitles = extractTitles(targetRows);
  const eachCountryTitles = extractTitles(
    targetRows.filter((r) => normaliseAggregation(r.level, r.aggregation) === "eachCountry")
  );
  const specTableRows = (reqLevel: ReqLevel) =>
    [...specMap.values(), ...specDepMap.values()].flat().filter((r) => r.level === reqLevel);
  const none = () => new Map<string, Set<string>>();
  const companyScope = [area.companyId];

  // An empty target list (no set, or none of its countries inside the viewed
  // theatre) skips the round-trips: `countries: []` would match nobody anyway.
  const [theatreNow, theatreProj, targetNow, targetProj, theatreTnc, targetTnc, ctxNow, ctxProj] = await Promise.all([
    getEmailSetsByTitle(theatreTitles, now, area.theatreScope),
    horizonDate ? getEmailSetsByTitle(theatreTitles, horizonDate, area.theatreScope) : null,
    hasTargets ? getEmailSetsByTitle(targetTitles, now, area.targetScope) : none(),
    horizonDate ? (hasTargets ? getEmailSetsByTitle(targetTitles, horizonDate, area.targetScope) : none()) : null,
    buildTrainedNotCertifiedContext(specTableRows("Theatre"), now, area.theatreScope),
    buildTrainedNotCertifiedContext(specTableRows("TargetCountries"), now, area.targetScope, hasTargets),
    // Over an empty target list this yields `countries: []`, on which every
    // "eachCountry" row fails closed — never "met in all zero countries".
    eachCountryTitles.length > 0
      ? buildCountryBucketContext(eachCountryTitles, now, area.meta.targetCountries, companyScope)
      : null,
    eachCountryTitles.length > 0 && horizonDate
      ? buildCountryBucketContext(eachCountryTitles, horizonDate, area.meta.targetCountries, companyScope)
      : null,
  ]);

  const theatreCtx: RowEvalContext = {
    emailSets: theatreNow,
    projectedEmailSets: theatreProj,
    countryCtx: null,
    tnc: theatreTnc,
    population: labelOf("theatre"),
  };
  const targetCtx: RowEvalContext = {
    emailSets: targetNow,
    projectedEmailSets: targetProj,
    countryCtx: ctxNow ? { now: ctxNow, projected: ctxProj } : null,
    tnc: targetTnc,
    population: labelOf("targetCountries"),
  };

  const specialisations = buildSpecialisationsWith(
    specMap,
    specDepMap,
    (r) => theatreViewPopulationOf(r.level) !== null,
    (r) => (theatreViewPopulationOf(r.level) === "theatre" ? theatreCtx : targetCtx),
    horizonDate !== null
  );

  const minimumCountriesGate: MinimumCountriesGate = {
    view: "theatre",
    required: area.meta.minimumCountries,
    counted: area.meta.targetCountries.length,
    met: area.meta.minimumMet,
    source: area.meta.minimumCountriesSource,
  };

  const merged = (theatre: Map<string, Set<string>>, targets: Map<string, Set<string>>) =>
    prefixKeys(POPULATION_KEY.targetCountries, targets, prefixKeys(POPULATION_KEY.theatre, theatre, new Map()));
  const noTheatreBuckets = new Map<string, Map<string, Set<string>>>();

  const tiers = p.isTiered
    ? evaluateTierBlock({
        rows: evaluated,
        tiers: p.tierRows,
        deploymentMode: p.deploymentMode,
        theatres: [],
        now: { emailSets: merged(theatreNow, targetNow), byTheatre: noTheatreBuckets, countryCtx: prefixCountryCtx(ctxNow) },
        projected:
          theatreProj && targetProj
            ? {
                emailSets: merged(theatreProj, targetProj),
                byTheatre: noTheatreBuckets,
                countryCtx: prefixCountryCtx(ctxProj),
              }
            : null,
        titleKey: (row, title) => `${POPULATION_KEY[theatreViewPopulationOf(row.level) ?? "theatre"]}::${title}`,
        populationOf: (row) => {
          const pop = theatreViewPopulationOf(row.level);
          return pop ? labelOf(pop) : null;
        },
        blocked: !area.meta.minimumMet,
        minimumCountriesGate,
      })
    : undefined;

  return {
    specialisations,
    ...lists,
    meta: { ...p.meta, targetCountries: area.meta as TargetCountriesMeta },
    horizonMonths,
    tiers,
  };
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
  const ctx: RowEvalContext = { emailSets, projectedEmailSets, countryCtx, tnc };
  return buildSpecialisationsWith(specMap, specDepMap, (r) => r.level === level, () => ctx, projectedEmailSets !== null);
}

/**
 * Everything one requirement row is counted against: the holder sets of its
 * population (now and, under a horizon, projected), the per-country buckets for
 * an `"eachCountry"` row, and the trained-not-certified context. A single-level
 * view has one of these for every row; a By Theatre view with target countries
 * has one per population, so a title used at both levels is counted over each
 * row's own population and never pooled across the two.
 */
interface RowEvalContext {
  emailSets: Map<string, Set<string>>;
  projectedEmailSets: Map<string, Set<string>> | null;
  countryCtx: CountryCtxPair | null;
  tnc: TrainedNotCertifiedContext | null;
  /** By Theatre with target countries only: which population the row is counted over, for display. */
  population?: PopulationLabel;
}

/** The population a By Theatre (with target countries) row was counted over, as the payload carries it. */
interface PopulationLabel {
  population: PopulationKind;
  /** The viewed theatre's name, or the target Country Set's name. */
  populationLabel: string;
}

/**
 * The general form of `buildSpecialisations`: `includeRow` picks the rows the
 * view reports (one level, or a By Theatre view's Theatre + TargetCountries), and `ctxOf` gives each
 * row the population it is counted over. `hasHorizon` says whether projected
 * figures exist at all, so a specialisation's `projectedCompliant` is present
 * exactly when it always was.
 */
function buildSpecialisationsWith(
  specMap: Map<string, SpecReqRow[]>,
  specDepMap: Map<string, SpecReqRow[]>,
  includeRow: (r: SpecReqRow) => boolean,
  ctxOf: (r: SpecReqRow) => RowEvalContext,
  hasHorizon: boolean
) {
  const mapReq = (req: SpecReqRow) => {
    const { emailSets, projectedEmailSets, countryCtx, tnc, population } = ctxOf(req);
    const aggregation = normaliseAggregation(req.level, req.aggregation);
    const common = {
      trainingType: req.trainingType ?? null,
      trainingTitle: req.trainingTitle ?? null,
      trainingFullTitle: req.trainingData?.fullTitle ?? "—",
      quantityRequired: req.quantityRequired,
      aggregation,
      // Spread rather than assigned, so the key is genuinely absent (not
      // `undefined`) on a row the figure does not apply to.
      ...(tnc && isTncRequirement(req, tnc.certTitles)
        ? { trainedNotCertified: trainedNotCertifiedEmails(req, tnc, emailSets).size }
        : {}),
    };
    const alternatives = req.alternatives.map((a) => ({
      trainingType: a.trainingType,
      trainingTitle: a.trainingTitle,
      trainingFullTitle: a.trainingData?.fullTitle ?? "—",
    }));
    // Spread for the same reason: absent outside a By Theatre view with target countries.
    const populationFields = population ?? {};

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
        ...populationFields,
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
      ...populationFields,
    };
  };

  const result = [];
  for (const [name, reqs] of specMap) {
    const levelReqs = reqs.filter(includeRow);
    if (levelReqs.length === 0) continue;

    // Deployment-purpose requirements for the same specialisation at this level.
    // They don't change whether the specialisation is achieved (that stays on
    // the qualifying requirements), but a tier that uses the specialisation
    // requires them too, so they're surfaced with their own met/not-met state.
    const depLevelReqs = (specDepMap.get(name) ?? []).filter(includeRow);
    const deploymentRequirements = depLevelReqs.map(mapReq);
    const deploymentCompliant =
      deploymentRequirements.length > 0
        ? deploymentRequirements.every((r) => r.compliant)
        : undefined;
    const projectedDeploymentCompliant =
      hasHorizon && deploymentRequirements.length > 0
        ? deploymentRequirements.every((r) => r.projectedCompliant ?? r.compliant)
        : undefined;

    const requirements = levelReqs.map(mapReq);
    result.push({
      name,
      compliant: requirements.every((r) => r.compliant),
      projectedCompliant: hasHorizon
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
 *
 * Program-wide gates (rows with neither a specialisation nor a tier) at this
 * level are required by every tier; see `evaluateTierBlock`. `blocked` /
 * `minimumCountriesGate` carry a view's minimum-countries gate (By Country Set).
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
  blocked?: boolean;
  minimumCountriesGate?: MinimumCountriesGate | null;
}) {
  const { levelName, scope, useTheatre, theatres, companyIds, rows, tiers, deploymentMode, now, horizonDate, countryCtx } = params;

  const levelRows = rows.filter((r) => r.level === levelName);
  const uniqueTitles = extractTitles(levelRows);

  const emptyByTheatre = new Map<string, Map<string, Set<string>>>();
  const emailSets = await getEmailSetsByTitle(uniqueTitles, now, scope);
  const byTheatre = useTheatre
    ? await getEmailSetsByTitleAndTheatre(uniqueTitles, now, companyIds)
    : emptyByTheatre;

  let projected: TierSnapshotSets | null = null;
  if (horizonDate) {
    projected = {
      emailSets: await getEmailSetsByTitle(uniqueTitles, horizonDate, scope),
      byTheatre: useTheatre
        ? await getEmailSetsByTitleAndTheatre(uniqueTitles, horizonDate, companyIds)
        : emptyByTheatre,
      countryCtx: countryCtx?.projected ?? undefined,
    };
  }

  return evaluateTierBlock({
    rows: levelRows,
    tiers,
    deploymentMode,
    theatres,
    now: { emailSets, byTheatre, countryCtx: countryCtx?.now },
    projected,
    titleKey: (_row, title) => title,
    populationOf: () => null,
    blocked: params.blocked ?? false,
    minimumCountriesGate: params.minimumCountriesGate ?? null,
  });
}

/** The holder sets one tier-ladder snapshot is evaluated against. */
interface TierSnapshotSets {
  emailSets: Map<string, Set<string>>;
  byTheatre: Map<string, Map<string, Set<string>>>;
  countryCtx: CountryBucketContext | undefined;
}

/**
 * The pure half of the tier block: build `TierLadderInput` from already-filtered
 * rows, evaluate it now (and at the horizon) against the supplied sets, and
 * shape the payload.
 *
 * `titleKey(row, title)` is the key a row's titles are looked up under in the
 * supplied sets. A single-level view passes the identity. A By Theatre view
 * with target countries passes a per-population prefix (`theatre::…` /
 * `targets::…`) over sets merged the same way, which is what lets
 * `evaluateTierLadder` — which takes ONE set map — count a Theatre row over the
 * theatre and a TargetCountries row over the target countries, and count a title used at both levels separately per
 * population, with no change to the engine. The display keeps the real titles.
 *
 * **Program-wide gates** — rows where `isProgramWideRow` (no specialisation, no
 * tier) — are passed to the engine as `gateReqIds`, so every tier requires them
 * in every deployment mode, and returned ONCE as `gateRequirements` rather than
 * repeated under each tier. They never appear in the specialisation tables.
 *
 * `blocked` fails every tier closed, now and projected (a view's unmet
 * minimum-countries gate); `minimumCountriesGate` is echoed as the reason.
 */
function evaluateTierBlock(params: {
  rows: TierBlockRow[];
  tiers: TierBlockTier[];
  deploymentMode: string;
  theatres: string[];
  now: TierSnapshotSets;
  projected: TierSnapshotSets | null;
  titleKey: (row: TierBlockRow, title: string) => string;
  populationOf: (row: TierBlockRow) => PopulationLabel | null;
  blocked: boolean;
  minimumCountriesGate: MinimumCountriesGate | null;
}) {
  const { rows: levelRows, tiers, deploymentMode, theatres, titleKey, populationOf, blocked, minimumCountriesGate } = params;

  const requirements = new Map<number, ProgramRequirement>();
  interface DepDisplay {
    trainingType: string | null;
    trainingTitle: string | null;
    trainingFullTitle: string;
    quantityRequired: number;
    minimumPerTheatre: number | null;
    aggregation: Aggregation;
    alternatives: { trainingType: string; trainingTitle: string; trainingFullTitle: string }[];
    population: PopulationLabel | null;
  }
  const display = new Map<number, DepDisplay>();
  for (const r of levelRows) {
    const aggregation = normaliseAggregation(r.level, r.aggregation);
    requirements.set(r.id, {
      trainingTitle: r.trainingTitle === null ? null : titleKey(r, r.trainingTitle),
      alternatives: r.alternatives.map((a) => ({ trainingTitle: titleKey(r, a.trainingTitle) })),
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
      population: populationOf(r),
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

  // Program-wide gates: neither a specialisation nor a tier.
  const gateReqIds = levelRows.filter(isProgramWideRow).map((r) => r.id);

  const tiersInput = tiers.map((t) => ({
    id: t.id,
    name: t.name,
    sortOrder: t.sortOrder,
    specialisationsRequired: t.specialisationsRequired,
    deploymentReqIds: tierDepIds.get(t.id) ?? [],
    deploymentReqIdsBySpec: tierSpecDepIds.get(t.id) ?? new Map<string, number[]>(),
  }));

  const input: TierLadderInput = { tiers: tiersInput, specs, requirements, deploymentMode, gateReqIds, blocked };

  const snapNow = evaluateTierLadder(input, params.now.emailSets, params.now.byTheatre, theatres, params.now.countryCtx);
  const snapProj = params.projected
    ? evaluateTierLadder(
        input,
        params.projected.emailSets,
        params.projected.byTheatre,
        theatres,
        params.projected.countryCtx
      )
    : null;

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
      // By Theatre with target countries only — absent (not null) elsewhere, like the spec tables.
      ...(d.population ?? {}),
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
    // Required by every tier, so shown once ("Required at every level") rather
    // than repeated under each. Empty for a program that has none.
    gateRequirements: gateReqIds.map((id) => buildDepReq(id, null)),
    // By Country Set and By Theatre (with target countries) only: the partner's
    // minimum number of countries for that view. When `met` is false every tier
    // above is unreached, now and projected. Null on every other view.
    minimumCountriesGate,
  };
}

export interface GetProgramStudentsOptions {
  trainingTitles: string[];
  /** As `BuildProgramReportOptions.level`. */
  level: string;
  /**
   * The program — needed to resolve a By Country Set view's default set and a
   * By Theatre view's target countries. Without it those views fall back to the
   * named set / the plain theatre.
   */
  programName?: string;
  /**
   * By Theatre view of a program with TargetCountries rows only: which
   * population the requirement is counted over — `"theatre"` (a Theatre row,
   * over the viewed theatre) or `"targetCountries"` (a TargetCountries row,
   * over the partner's target countries in it) — so the roster matches the
   * row's own figure. Missing there, the roster fails closed to empty (the
   * routes 400 it first). Ignored on every other view.
   */
  population?: PopulationKind | null;
  country: string;
  region: string;
  /**
   * Country Set name: the set viewed on level "countrySet" (blank = the
   * partner's configured set), or the target set on level "theatre" of a
   * program with TargetCountries rows (blank = the configured target set).
   */
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
 * `buildProgramReport` counts the selected level over, so both rosters match
 * their figures exactly. Returns `hasArea: false` for a Region / Country Set
 * view (or a target-countries population) that resolves to no countries, and
 * for anything the report itself would fail closed on.
 */
async function resolveRosterScope(
  opts: GetProgramStudentsOptions
): Promise<{ scope: ComplianceScope; hasArea: boolean }> {
  const { level, country, region, theatre, companyIds } = opts;
  const countrySet = opts.countrySet ?? "";
  const closed = { scope: { countries: [] as string[], companyIds }, hasArea: false };
  if (level === "country" && country) return { scope: { country, companyIds }, hasArea: true };
  if (level === "region" && region) {
    const countries = await countriesInRegion(region);
    return { scope: { countries, companyIds }, hasArea: countries.length > 0 };
  }
  if (level === "countrySet") {
    // The same resolution as the report: the named set, else the partner's
    // configured one; an ambiguous company scope fails closed to `[]`, so two
    // companies' same-named sets are never merged.
    const program = opts.programName ? await getProgramTerms(opts.programName) : null;
    const view = await resolveCountrySetView(program, countrySet, companyIds);
    if (!view) return closed;
    const countries = view.meta.countries;
    return { scope: { countries, companyIds }, hasArea: countries.length > 0 };
  }
  if (level === "theatre" && theatre) {
    if (opts.programName && (await programHasTargetCountryRows(opts.programName))) {
      return resolveTargetRosterScope(opts.programName, opts);
    }
    return { scope: { theatre, companyIds }, hasArea: true };
  }
  return { scope: { companyIds }, hasArea: true };
}

/**
 * The roster scope of a By Theatre view of a program with TargetCountries
 * rows: the requirement's own population — the theatre for a Theatre row, the
 * target countries for a TargetCountries row — resolved through the same
 * `resolveTargetArea` the report counts over, so the list matches the figure.
 * Anything unresolvable (no program row, not exactly one company, no
 * population named) is an empty area.
 */
async function resolveTargetRosterScope(
  programName: string,
  opts: GetProgramStudentsOptions
): Promise<{ scope: ComplianceScope; hasArea: boolean }> {
  const closed = { scope: { countries: [] as string[], companyIds: opts.companyIds }, hasArea: false };
  if (!opts.population) return closed;
  const program = await getProgramTerms(programName);
  if (!program) return closed;
  const area = await resolveTargetArea({
    program,
    theatre: opts.theatre,
    countrySet: opts.countrySet,
    companyIds: opts.companyIds,
  });
  if ("error" in area) return closed;
  if (opts.population === "theatre") return { scope: area.theatreScope, hasArea: true };
  return { scope: area.targetScope, hasArea: area.meta.targetCountries.length > 0 };
}

/**
 * Roster drill-down: the distinct, currently-active holders of any of the given
 * training titles, scoped to the level selector + companies. Returns the plain
 * object the callers wrap in a JSON response. With `trainedNotCertified`, the
 * roster behind the "Trained not certified" figure instead.
 */
export async function getProgramStudents(opts: GetProgramStudentsOptions) {
  const { scope, hasArea } = await resolveRosterScope(opts);
  if (opts.trainedNotCertified) {
    return getTrainedNotCertifiedRoster(opts.trainingTitles, scope, hasArea);
  }
  // An area with no countries (an unknown region or set, a theatre holding
  // none of the target set) is the honest empty roster — never everybody.
  if (!hasArea) return { students: [] };
  const { trainingTitles, companyIds } = opts;
  const now = new Date();

  const studentFilter: Record<string, unknown> = {};
  if (scope.country) studentFilter.country = scope.country;
  if (scope.countries) studentFilter.country = { in: scope.countries };
  if (scope.theatre) studentFilter.theatre = scope.theatre;
  // Empty array = "no accessible companies", which must match nothing. Testing
  // `length > 0` dropped the filter and returned every company's holders.
  // `null` stays the deliberate "unrestricted" case; `[]` is truthy and yields
  // `in: []`. The callers short-circuit on an empty scope today (see the note
  // on BuildProgramReportOptions.companyIds), but this no longer relies on it.
  // The resolved scope's own company list (a single company on a Country Set
  // or target-countries view) is what is applied, falling back to the caller's.
  const scopeCompanies = scope.companyIds !== undefined ? scope.companyIds : companyIds;
  if (scopeCompanies) {
    studentFilter.companyId = { in: scopeCompanies };
  }

  // Expand each requested title to its fullTitle+type sibling group so the roster
  // matches the attained count (which unions sibling variants via
  // getEmailSetsByTitle). Without this, holders of a sibling variant of the
  // primary or an alternative are counted but missing from the View list.
  const { fetchTitles } = await resolveSiblingTitles(trainingTitles);

  const records = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: fetchTitles },
      // The same point-in-time rule as the Attained count
      // (`getEmailSetsByTitle`), so a future-dated completion cannot put
      // someone on the list who is not in the number.
      completedDate: { lte: now },
      expiryDate: { gt: now },
      ...(Object.keys(studentFilter).length > 0 ? { student: studentFilter } : {}),
    },
    include: {
      student: { select: { fullName: true, email: true, country: true, theatre: true } },
      trainingData: { select: { fullTitle: true } },
    },
  });

  // Every qualifying training a person holds (primary, alternatives), not only
  // their latest — the modal lists people per training.
  return { students: toRosterRows(records) };
}
