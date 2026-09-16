/**
 * Shared compliance calculation utilities used by the data-driven program
 * dashboards and the Program Compliance Trend report.
 *
 * The data model centres on ProgramData rows, each of which may have
 * ProgramDataAlternative children (OR logic — any of {primary, ...alternatives}
 * counts toward the requirement's quantity). A "compliant" requirement is one
 * where the union of unique students holding any qualifying training meets or
 * exceeds quantityRequired (and, for Global-level requirements carrying a
 * minimumPerTheatre, every theatre meets that minimum too).
 */

import prisma from "@/lib/prisma";
import { ELIGIBLE_TRAINING_DATA } from "@/lib/reportable-training";

export interface ComplianceScope {
  country?: string;
  countries?: string[];
  theatre?: string;
  /**
   * Optional company filter. `null` means no restriction (e.g. SuperAdmin or
   * "all companies" selection). An empty array means the caller is restricted
   * to no companies and the result should be empty.
   */
  companyIds?: number[] | null;
}

/**
 * Which geographic column of `Student` a bucketed count is grouped by.
 *
 * Both are single, non-null columns on `Student` (`theatre` is denormalised
 * from `RegionData.theatre` on create/edit), which is what makes the partition
 * clean — see the bucketing comment in `getEmailSetsByTitleAndGeo`.
 */
export type GeoBucket = "theatre" | "country";

/** A program data row shape sufficient for compliance calculations. */
export interface ProgramRequirement {
  trainingTitle: string | null;
  alternatives: { trainingTitle: string }[];
  quantityRequired: number;
  minimumPerTheatre?: number | null;
}

/** Resolve a region name to its member countries (via RegionData). */
export async function countriesInRegion(region: string): Promise<string[]> {
  if (!region) return [];
  const rows = await prisma.regionData.findMany({
    where: { region },
    select: { country: true },
  });
  return rows.map((r: { country: string }) => r.country);
}

/** Collect the unique union of primary + alternative training titles. */
export function extractTitles(rows: ProgramRequirement[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    if (r.trainingTitle) set.add(r.trainingTitle);
    for (const alt of r.alternatives) set.add(alt.trainingTitle);
  }
  return [...set];
}

/**
 * Multiple `trainingTitle`s can legitimately share one `fullTitle` (common from
 * imports), and the app counts a person who holds *any* such variant (the
 * training catalogue and dashboards group by fullTitle + trainingType). A
 * program requirement stores a single representative `trainingTitle`, so before
 * counting we expand it to its whole sibling group (same fullTitle + type).
 *
 * Returns the flat list of titles to fetch (all siblings) plus a map from each
 * requested title to every trainingTitle in its group (including itself), so
 * callers can merge sibling email sets under the requested key. Single-variant
 * names resolve to `[self]`, making this a no-op for them.
 */
export async function resolveSiblingTitles(trainingTitles: string[]): Promise<{
  fetchTitles: string[];
  groupMembers: Map<string, string[]>;
}> {
  const pairKey = (fullTitle: string, type: string) => `${fullTitle}::${type}`;

  const requested = await prisma.trainingData.findMany({
    where: { trainingTitle: { in: trainingTitles } },
    select: { trainingTitle: true, fullTitle: true, trainingType: true },
  });

  // Titles with no catalogue row (shouldn't happen via FK) stay singleton.
  if (requested.length === 0) {
    const groupMembers = new Map<string, string[]>();
    for (const t of trainingTitles) groupMembers.set(t, [t]);
    return { fetchTitles: [...new Set(trainingTitles)], groupMembers };
  }

  // Distinct (fullTitle, trainingType) pairs — keep the enum-typed trainingType
  // from the query result so the OR filter matches Prisma's where input type.
  const seenPair = new Set<string>();
  const orPairs: { fullTitle: string; trainingType: (typeof requested)[number]["trainingType"] }[] = [];
  for (const r of requested) {
    const k = pairKey(r.fullTitle, r.trainingType);
    if (!seenPair.has(k)) {
      seenPair.add(k);
      orPairs.push({ fullTitle: r.fullTitle, trainingType: r.trainingType });
    }
  }

  // Reviewed rows only. Sibling expansion matches on (fullTitle, trainingType)
  // rather than on a configured title, so an unreviewed import can be pulled in
  // without anyone having configured it: the auto-create sets
  // `fullTitle = trainingTitle` and a placeholder type of `Certification`, so a
  // freshly-imported title that happens to equal a configured certification's
  // Full Title would join that requirement's group and contribute its holders
  // to the attained count and the roster drill-down.
  const siblings = await prisma.trainingData.findMany({
    where: { AND: [ELIGIBLE_TRAINING_DATA, { OR: orPairs }] },
    select: { trainingTitle: true, fullTitle: true, trainingType: true },
  });

  const membersByPair = new Map<string, string[]>();
  for (const s of siblings) {
    const k = pairKey(s.fullTitle, s.trainingType);
    if (!membersByPair.has(k)) membersByPair.set(k, []);
    membersByPair.get(k)!.push(s.trainingTitle);
  }

  const reqByTitle = new Map(requested.map((r) => [r.trainingTitle, r]));
  const groupMembers = new Map<string, string[]>();
  const fetchSet = new Set<string>();
  for (const t of trainingTitles) {
    const r = reqByTitle.get(t);
    const members = r ? membersByPair.get(pairKey(r.fullTitle, r.trainingType)) ?? [t] : [t];
    groupMembers.set(t, members);
    for (const m of members) fetchSet.add(m);
  }
  return { fetchTitles: [...fetchSet], groupMembers };
}

/**
 * Translate a `ComplianceScope` into the `student` relation filter shared by
 * every holder query here, so the scope is honoured identically whether or not
 * the result is bucketed.
 *
 * The company rule is the one from CLAUDE.md ("Writing a route handler", item
 * 3): an empty array means "this caller may read no companies" and must match
 * nothing, while `null`/`undefined` is the separate, deliberate "unrestricted"
 * case. Callers early-return an empty result on `companyIds.length === 0`
 * *before* reaching this builder, which is why the `length > 0` test below is
 * unreachable with an empty array and is correct as written — it is kept so the
 * builder fails closed on its own if a future caller forgets the early return.
 *
 * `countries: []` deliberately has no such guard: it is applied as `in: []`,
 * which matches nothing, which is the honest answer for an empty country list.
 */
function buildStudentFilter(scope: ComplianceScope): Record<string, unknown> {
  const studentFilter: Record<string, unknown> = {};
  if (scope.country) studentFilter.country = scope.country;
  if (scope.countries) studentFilter.country = { in: scope.countries };
  if (scope.theatre) studentFilter.theatre = scope.theatre;
  if (Array.isArray(scope.companyIds) && scope.companyIds.length > 0) {
    studentFilter.companyId = { in: scope.companyIds };
  }
  return studentFilter;
}

/**
 * Merge each requested title's sibling group into one union per bucket, keyed
 * by the *requested* title, so `unionAttained*` lookups see every catalogue
 * variant's holders (see `resolveSiblingTitles`). Shared by the bucketed query
 * so the flat and bucketed paths cannot drift.
 */
function mergeSiblingBuckets(
  groupMembers: Map<string, string[]>,
  rawByTitle: Map<string, Map<string, Set<string>>>
): Map<string, Map<string, Set<string>>> {
  const map = new Map<string, Map<string, Set<string>>>();
  for (const [requested, members] of groupMembers) {
    const merged = new Map<string, Set<string>>();
    for (const m of members) {
      const byBucket = rawByTitle.get(m);
      if (!byBucket) continue;
      for (const [bucket, emails] of byBucket) {
        if (!merged.has(bucket)) merged.set(bucket, new Set());
        const set = merged.get(bucket)!;
        for (const e of emails) set.add(e);
      }
    }
    map.set(requested, merged);
  }
  return map;
}

/**
 * Email-sets keyed by training title for a given scope, considering only
 * trainings that are valid *as of* `asOf` — i.e. completed on or before `asOf`
 * (`completedDate <= asOf`) and not yet expired (`expiryDate > asOf`). The
 * completedDate clause is what makes point-in-time/historical snapshots
 * correct: without it a past month would count trainings completed *after*
 * that month. For `asOf = now` (and future horizons) the completedDate clause
 * is always satisfied by existing rows, so live/forecast callers are
 * unaffected. Empty input → empty map.
 *
 * Each requested title is expanded to its fullTitle+type sibling group and the
 * group's holders are merged under the requested key, so a requirement counts
 * anyone holding any catalogue variant of the chosen training (see
 * `resolveSiblingTitles`).
 */
export async function getEmailSetsByTitle(
  trainingTitles: string[],
  asOf: Date,
  scope: ComplianceScope = {}
): Promise<Map<string, Set<string>>> {
  if (trainingTitles.length === 0) return new Map();
  if (Array.isArray(scope.companyIds) && scope.companyIds.length === 0) return new Map();

  const { fetchTitles, groupMembers } = await resolveSiblingTitles(trainingTitles);

  const studentFilter = buildStudentFilter(scope);

  const rows = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: fetchTitles },
      completedDate: { lte: asOf },
      expiryDate: { gt: asOf },
      ...(Object.keys(studentFilter).length > 0 ? { student: studentFilter } : {}),
    },
    select: { trainingTitle: true, email: true },
  });

  const rawByTitle = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!rawByTitle.has(r.trainingTitle)) rawByTitle.set(r.trainingTitle, new Set());
    rawByTitle.get(r.trainingTitle)!.add(r.email);
  }

  // Merge each requested title's sibling group into one union, keyed by the
  // requested title so unionAttained lookups see every variant's holders.
  const map = new Map<string, Set<string>>();
  for (const [requested, members] of groupMembers) {
    const u = new Set<string>();
    for (const m of members) {
      const s = rawByTitle.get(m);
      if (s) for (const e of s) u.add(e);
    }
    map.set(requested, u);
  }
  return map;
}

/**
 * Email sets keyed by trainingTitle and then by a geographic bucket — the
 * `theatre` or the `country` of the holding student.
 *
 * This is `getEmailSetsByTitle` with one extra grouping level; everything that
 * makes the flat query correct is inherited rather than reimplemented:
 *
 *  - **Point-in-time semantics** — the same `completedDate <= asOf` /
 *    `expiryDate > asOf` pair, so historical and forecast snapshots stay honest.
 *  - **Sibling expansion** — `resolveSiblingTitles`, which carries the
 *    `ELIGIBLE_TRAINING_DATA` filter for the load-bearing reason documented
 *    there (an unreviewed auto-created import row would otherwise join a
 *    configured requirement's group and contribute holders nobody configured).
 *  - **Scope** — the full `ComplianceScope`, so a country-list restriction
 *    (`scope.countries`) is expressible. The theatre wrapper below only ever
 *    passed a company filter; bucketing by country *within* a supplied country
 *    list is what the offering geography breakdown needs.
 *  - **Empty company scope matches nothing** — the early return below, plus
 *    `buildStudentFilter`'s own guard.
 *
 * Empty input → empty map.
 */
export async function getEmailSetsByTitleAndGeo(
  trainingTitles: string[],
  asOf: Date,
  bucket: GeoBucket,
  scope: ComplianceScope = {}
): Promise<Map<string, Map<string, Set<string>>>> {
  if (trainingTitles.length === 0) return new Map();
  // An empty array is "may read no companies" and must match nothing; `null`
  // and `undefined` are the separate, deliberate "unrestricted" case.
  if (Array.isArray(scope.companyIds) && scope.companyIds.length === 0) return new Map();

  const { fetchTitles, groupMembers } = await resolveSiblingTitles(trainingTitles);
  const studentFilter = buildStudentFilter(scope);

  const rows = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: fetchTitles },
      completedDate: { lte: asOf },
      expiryDate: { gt: asOf },
      ...(Object.keys(studentFilter).length > 0 ? { student: studentFilter } : {}),
    },
    select: {
      trainingTitle: true,
      email: true,
      student: { select: { theatre: true, country: true } },
    },
  });

  const rawByTitle = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    let byBucket = rawByTitle.get(r.trainingTitle);
    if (!byBucket) {
      byBucket = new Map();
      rawByTitle.set(r.trainingTitle, byBucket);
    }
    // A student lands in exactly ONE bucket, because `Student.theatre` and
    // `Student.country` are each a single non-null column — so the buckets
    // partition the population and, since the sets hold distinct emails, the
    // per-bucket counts sum to the count over the whole scope. That property is
    // load-bearing: it is what lets a per-country breakdown be checked against
    // the Onshore/Nearshore/Offshore band totals, and what stops the same person
    // being counted in two places. If a student ever gains multiple countries
    // (or theatres), every per-bucket map here silently starts double-counting
    // and every such check silently stops holding.
    const key = bucket === "theatre" ? r.student.theatre : r.student.country;
    if (!byBucket.has(key)) byBucket.set(key, new Set());
    byBucket.get(key)!.add(r.email);
  }

  return mergeSiblingBuckets(groupMembers, rawByTitle);
}

/**
 * Email sets keyed by trainingTitle and then by theatre. Used for the
 * per-theatre breakdown of Global-level requirements.
 *
 * A thin wrapper over `getEmailSetsByTitleAndGeo` — kept so its existing call
 * sites read unchanged.
 */
export async function getEmailSetsByTitleAndTheatre(
  trainingTitles: string[],
  asOf: Date,
  companyIds?: number[] | null
): Promise<Map<string, Map<string, Set<string>>>> {
  return getEmailSetsByTitleAndGeo(trainingTitles, asOf, "theatre", { companyIds });
}

/** Union of unique emails across primary + alternatives, given an emailSets map. */
export function unionAttained(req: ProgramRequirement, emailSets: Map<string, Set<string>>): number {
  if (!req.trainingTitle) return 0;
  const titles = [req.trainingTitle, ...req.alternatives.map((a) => a.trainingTitle)];
  const u = new Set<string>();
  for (const t of titles) {
    const set = emailSets.get(t);
    if (set) for (const e of set) u.add(e);
  }
  return u.size;
}

/**
 * Per-bucket attained counts for a requirement — the bucketed sibling of
 * `unionAttained`, counting distinct emails across primary + alternatives
 * within each geographic bucket.
 *
 * With `buckets` supplied, returns one entry per requested bucket **in that
 * order, including zeros** (what a per-theatre minimum check needs: a theatre
 * with nobody in it must read 0, not be absent). With `buckets` omitted,
 * returns every bucket that actually has a holder, sorted by name — what a
 * distribution needs, where a bucket with no holders is either absent from the
 * data or genuinely empty and the caller decides which.
 *
 * Because the buckets partition the population (see `getEmailSetsByTitleAndGeo`)
 * the counts returned with `buckets` omitted sum to `unionAttained` over the
 * same scope.
 */
export function unionAttainedByGeo(
  req: ProgramRequirement,
  byTitleAndGeo: Map<string, Map<string, Set<string>>>,
  buckets?: string[]
): { bucket: string; count: number }[] {
  if (!req.trainingTitle) return [];
  const titles = [req.trainingTitle, ...req.alternatives.map((a) => a.trainingTitle)];
  const keys =
    buckets ??
    [
      ...new Set(
        titles.flatMap((t) => [...(byTitleAndGeo.get(t)?.keys() ?? [])])
      ),
    ].sort((a, b) => a.localeCompare(b));
  const out: { bucket: string; count: number }[] = [];
  for (const bucket of keys) {
    const u = new Set<string>();
    for (const t of titles) {
      const set = byTitleAndGeo.get(t)?.get(bucket);
      if (set) for (const e of set) u.add(e);
    }
    out.push({ bucket, count: u.size });
  }
  return out;
}

/**
 * Per-theatre attained counts for a requirement (used when minimumPerTheatre is
 * set). A thin wrapper over `unionAttainedByGeo`, kept so its existing call
 * sites read unchanged.
 */
export function unionAttainedByTheatre(
  req: ProgramRequirement,
  byTitleAndTheatre: Map<string, Map<string, Set<string>>>,
  theatres: string[]
): { theatre: string; count: number }[] {
  return unionAttainedByGeo(req, byTitleAndTheatre, theatres).map((r) => ({
    theatre: r.bucket,
    count: r.count,
  }));
}

/**
 * Evaluate a single requirement against an email-set snapshot: the distinct
 * attained count, an optional per-theatre breakdown (when a minimumPerTheatre is
 * set), and whether it is compliant (global count met AND every theatre minimum
 * met). Shared by specialisation-achievement and tier-ladder evaluation.
 */
function requirementCompliant(
  req: ProgramRequirement,
  emailSets: Map<string, Set<string>>,
  byTitleAndTheatre?: Map<string, Map<string, Set<string>>>,
  theatres?: string[]
): { attained: number; compliant: boolean; theatreBreakdown: { theatre: string; count: number; compliant: boolean }[] | null } {
  if (!req.trainingTitle) return { attained: 0, compliant: false, theatreBreakdown: null };
  const attained = unionAttained(req, emailSets);
  const min = req.minimumPerTheatre ?? null;
  let theatreBreakdown: { theatre: string; count: number; compliant: boolean }[] | null = null;
  if (min !== null && min > 0 && byTitleAndTheatre && theatres) {
    theatreBreakdown = unionAttainedByTheatre(req, byTitleAndTheatre, theatres).map((t) => ({
      theatre: t.theatre,
      count: t.count,
      compliant: t.count >= min,
    }));
  }
  const primaryMet = attained >= req.quantityRequired;
  const theatresMet = theatreBreakdown === null || theatreBreakdown.every((t) => t.compliant);
  return { attained, compliant: primaryMet && theatresMet, theatreBreakdown };
}

/**
 * A specialisation is "achieved" when *every* one of its qualifying requirements
 * is compliant (distinct-people union >= quantityRequired, and — where a
 * minimumPerTheatre is set — every theatre meets it). An empty requirement list
 * is never achieved.
 */
export function isSpecialisationAchieved(
  qualifyingReqs: ProgramRequirement[],
  emailSets: Map<string, Set<string>>,
  byTitleAndTheatre?: Map<string, Map<string, Set<string>>>,
  theatres?: string[]
): boolean {
  if (qualifyingReqs.length === 0) return false;
  return qualifyingReqs.every(
    (req) => requirementCompliant(req, emailSets, byTitleAndTheatre, theatres).compliant
  );
}

/** Tier ladder input, keyed by requirement id so callers can map back to display rows. */
export interface TierLadderInput {
  tiers: {
    id: number;
    name: string;
    sortOrder: number;
    specialisationsRequired: number;
    /** Deployment requirement ids for "flat" mode. */
    deploymentReqIds: number[];
    /**
     * Deployment requirement ids keyed by specialisation name, for
     * "perTierPerSpecialisation" mode: this tier's deployment certs for each
     * specialisation. Only the achieved specialisations' entries are enforced.
     */
    deploymentReqIdsBySpec?: Map<string, number[]>;
  }[];
  specs: {
    name: string;
    qualifyingReqIds: number[];
    /** Deployment requirement ids used in "perAchievedSpecialisation" mode. */
    deploymentReqIds: number[];
  }[];
  /** All referenced requirements, keyed by id. */
  requirements: Map<number, ProgramRequirement>;
  deploymentMode: string;
}

/** A point-in-time snapshot of tier-ladder compliance. */
export interface TierLadderSnapshot {
  achievedSpecs: Set<string>;
  reqAttained: Map<number, number>;
  reqCompliant: Map<number, boolean>;
  reqTheatreBreakdown: Map<number, { theatre: string; count: number; compliant: boolean }[] | null>;
  tierCompliant: Map<number, boolean>;
  /** Distinct achieved-specialisation count (same for every tier). */
  achievedSpecCount: number;
  /**
   * Per-tier count of specialisations that meet ALL of that tier's criteria
   * (achieved + all the tier's deployment reqs for that spec met — a spec with
   * no deployment reqs for the tier counts on qualification alone). Only
   * populated in "perTierPerSpecialisation" mode; drives that mode's tier gate
   * and its per-tier display.
   */
  tierSatisfiedSpecCount: Map<number, number>;
  /** id of the highest (by sortOrder) compliant tier, or null. */
  highestAchievedTierId: number | null;
}

/**
 * Evaluate the whole tier ladder for a single email-set snapshot (a given level
 * + scope, at a given as-of date). Pure — reuses `unionAttained` /
 * `unionAttainedByTheatre` so it counts distinct people. Called once for "now"
 * and again at the projection horizon.
 *
 * A specialisation is achieved when all its qualifying requirements are met. A
 * tier is compliant when the achieved-specialisation count meets its
 * `specialisationsRequired` AND its deployment requirements are met — sourced by
 * `deploymentMode`:
 *  - "flat": the tier's own deployment requirements.
 *  - "perAchievedSpecialisation": every achieved specialisation's deployment
 *    requirements. (If no specialisation is achieved there is nothing extra to
 *    prove, so deployment is trivially met and the gate is the spec count.)
 *  - "perTierPerSpecialisation": the tier is met when at least
 *    `specialisationsRequired` specialisations each meet ALL of the tier's
 *    criteria — achieved AND all of that tier's deployment reqs for the spec met
 *    (a spec with no deployment reqs for the tier counts on qualification
 *    alone). Unmet specialisations simply don't count toward the total, so a
 *    partner reaches the tier as soon as enough specialisations are fully met.
 */
export function evaluateTierLadder(
  input: TierLadderInput,
  emailSets: Map<string, Set<string>>,
  byTitleAndTheatre: Map<string, Map<string, Set<string>>>,
  theatres: string[]
): TierLadderSnapshot {
  const { tiers, specs, requirements, deploymentMode } = input;

  const reqAttained = new Map<number, number>();
  const reqCompliant = new Map<number, boolean>();
  const reqTheatreBreakdown = new Map<number, { theatre: string; count: number; compliant: boolean }[] | null>();

  const referenced = new Set<number>();
  for (const s of specs) {
    s.qualifyingReqIds.forEach((i) => referenced.add(i));
    s.deploymentReqIds.forEach((i) => referenced.add(i));
  }
  for (const t of tiers) {
    t.deploymentReqIds.forEach((i) => referenced.add(i));
    t.deploymentReqIdsBySpec?.forEach((ids) => ids.forEach((i) => referenced.add(i)));
  }

  for (const id of referenced) {
    const req = requirements.get(id);
    if (!req) {
      reqAttained.set(id, 0);
      reqCompliant.set(id, false);
      reqTheatreBreakdown.set(id, null);
      continue;
    }
    const r = requirementCompliant(req, emailSets, byTitleAndTheatre, theatres);
    reqAttained.set(id, r.attained);
    reqCompliant.set(id, r.compliant);
    reqTheatreBreakdown.set(id, r.theatreBreakdown);
  }

  const achievedSpecs = new Set<string>();
  const specByName = new Map(specs.map((s) => [s.name, s]));
  for (const s of specs) {
    if (s.qualifyingReqIds.length > 0 && s.qualifyingReqIds.every((id) => reqCompliant.get(id) === true)) {
      achievedSpecs.add(s.name);
    }
  }
  const achievedSpecCount = achievedSpecs.size;

  const tierCompliant = new Map<number, boolean>();
  const tierSatisfiedSpecCount = new Map<number, number>();
  let highestAchievedTierId: number | null = null;
  for (const t of [...tiers].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const specsMet = achievedSpecCount >= t.specialisationsRequired;
    let deploymentMet: boolean;
    if (deploymentMode === "perAchievedSpecialisation") {
      deploymentMet = [...achievedSpecs].every((name) => {
        const s = specByName.get(name);
        return !s || s.deploymentReqIds.every((id) => reqCompliant.get(id) === true);
      });
    } else if (deploymentMode === "perTierPerSpecialisation") {
      // Count specialisations that meet ALL of this tier's criteria: achieved AND
      // every one of the tier's deployment reqs for that spec met (a spec with no
      // deployment reqs counts on qualification alone). The tier is reached once
      // enough such specialisations exist — unmet specialisations don't block.
      const satisfied = [...achievedSpecs].filter((name) =>
        (t.deploymentReqIdsBySpec?.get(name) ?? []).every((id) => reqCompliant.get(id) === true)
      ).length;
      tierSatisfiedSpecCount.set(t.id, satisfied);
      deploymentMet = satisfied >= t.specialisationsRequired;
    } else {
      deploymentMet = t.deploymentReqIds.every((id) => reqCompliant.get(id) === true);
    }
    const compliant = specsMet && deploymentMet;
    tierCompliant.set(t.id, compliant);
    if (compliant) highestAchievedTierId = t.id;
  }

  return {
    achievedSpecs,
    reqAttained,
    reqCompliant,
    reqTheatreBreakdown,
    tierCompliant,
    achievedSpecCount,
    tierSatisfiedSpecCount,
    highestAchievedTierId,
  };
}

/** Return the list of distinct, non-empty theatre names across all (scoped) students. */
export async function listTheatres(companyIds?: number[] | null): Promise<string[]> {
  if (Array.isArray(companyIds) && companyIds.length === 0) return [];
  const rows = await prisma.student.findMany({
    where: Array.isArray(companyIds) && companyIds.length > 0 ? { companyId: { in: companyIds } } : {},
    select: { theatre: true },
    distinct: ["theatre"],
    orderBy: { theatre: "asc" },
  });
  return rows.map((r: { theatre: string }) => r.theatre).filter(Boolean);
}
