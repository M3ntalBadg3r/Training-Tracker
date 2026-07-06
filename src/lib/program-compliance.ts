/**
 * Shared compliance calculation utilities used by the data-driven program
 * dashboards and the Program Compliance Trend report.
 *
 * The data model centres on ProgramData rows, each of which may have
 * ProgramDataAlternative children (OR logic — any of {primary, ...alternatives}
 * counts toward the requirement's quantity). A "compliant" requirement is one
 * where the union of unique students holding any qualifying training meets or
 * exceeds quantityRequired (and, for Global Diamond requirements with a
 * minimumPerTheatre, every theatre meets that minimum too).
 */

import prisma from "@/lib/prisma";

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
async function resolveSiblingTitles(trainingTitles: string[]): Promise<{
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

  const siblings = await prisma.trainingData.findMany({
    where: { OR: orPairs },
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

  const studentFilter: Record<string, unknown> = {};
  if (scope.country) studentFilter.country = scope.country;
  if (scope.countries) studentFilter.country = { in: scope.countries };
  if (scope.theatre) studentFilter.theatre = scope.theatre;
  if (Array.isArray(scope.companyIds) && scope.companyIds.length > 0) {
    studentFilter.companyId = { in: scope.companyIds };
  }

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
 * Email sets keyed by trainingTitle and then by theatre. Used for Global
 * Diamond's per-theatre breakdown.
 */
export async function getEmailSetsByTitleAndTheatre(
  trainingTitles: string[],
  asOf: Date,
  companyIds?: number[] | null
): Promise<Map<string, Map<string, Set<string>>>> {
  if (trainingTitles.length === 0) return new Map();
  if (Array.isArray(companyIds) && companyIds.length === 0) return new Map();

  const { fetchTitles, groupMembers } = await resolveSiblingTitles(trainingTitles);

  const rows = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: fetchTitles },
      completedDate: { lte: asOf },
      expiryDate: { gt: asOf },
      ...(Array.isArray(companyIds) && companyIds.length > 0
        ? { student: { companyId: { in: companyIds } } }
        : {}),
    },
    select: {
      trainingTitle: true,
      email: true,
      student: { select: { theatre: true } },
    },
  });

  const rawByTitle = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    let byTheatre = rawByTitle.get(r.trainingTitle);
    if (!byTheatre) {
      byTheatre = new Map();
      rawByTitle.set(r.trainingTitle, byTheatre);
    }
    const theatre = r.student.theatre;
    if (!byTheatre.has(theatre)) byTheatre.set(theatre, new Set());
    byTheatre.get(theatre)!.add(r.email);
  }

  // Merge each requested title's sibling group per theatre, keyed by the
  // requested title (see resolveSiblingTitles).
  const map = new Map<string, Map<string, Set<string>>>();
  for (const [requested, members] of groupMembers) {
    const merged = new Map<string, Set<string>>();
    for (const m of members) {
      const byTheatre = rawByTitle.get(m);
      if (!byTheatre) continue;
      for (const [theatre, emails] of byTheatre) {
        if (!merged.has(theatre)) merged.set(theatre, new Set());
        const set = merged.get(theatre)!;
        for (const e of emails) set.add(e);
      }
    }
    map.set(requested, merged);
  }
  return map;
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

/** Per-theatre attained counts for a requirement (used when minimumPerTheatre is set). */
export function unionAttainedByTheatre(
  req: ProgramRequirement,
  byTitleAndTheatre: Map<string, Map<string, Set<string>>>,
  theatres: string[]
): { theatre: string; count: number }[] {
  if (!req.trainingTitle) return [];
  const titles = [req.trainingTitle, ...req.alternatives.map((a) => a.trainingTitle)];
  return theatres.map((theatre) => {
    const u = new Set<string>();
    for (const t of titles) {
      const set = byTitleAndTheatre.get(t)?.get(theatre);
      if (set) for (const e of set) u.add(e);
    }
    return { theatre, count: u.size };
  });
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
