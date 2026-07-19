/**
 * Compliance Planning engine — the "action layer" over the program-compliance
 * substrate. The program dashboards answer "what is the gap?"; this module
 * answers "who do we move, in what order, for the least effort?".
 *
 * Everything bottoms out in one primitive the dashboards already use: count
 * distinct people who satisfy a requirement's qualifying training set (OR-logic
 * union, sibling-expanded, company + geography scoped, point-in-time). We reuse
 * `getEmailSetsByTitle` from `lib/program-compliance.ts` for that so the plan and
 * the dashboards can never disagree on what counts as *met*.
 *
 * On top of the gap we nominate the cheapest specific people to close it, ranked:
 *   1. easy-win        — did an ILT/OLX that leads to the cert, never certified
 *                        (needs only the exam). Uses the reverse ILT/OLX→cert index.
 *   2. lapsed          — held the cert but it expired (needs only a renewal).
 *   3. legacy          — holds an active legacy cert whose `replacedBy` names the
 *                        required cert (an upgrade path).
 *   4. net-new         — anyone else; the full ILT/OLX→cert path. Not enumerated
 *                        by person (any student could be trained) — reported as a
 *                        remaining count with the path shown.
 *
 * Because a person can only be *spent once*, candidate assignment is a greedy
 * allocation across the whole target (not an independent per-requirement count):
 * committing a person to earn one cert credits every requirement instance that
 * needs *that same cert* over a population containing them (the §7 "one exam
 * closes Cert X in the UK, in EMEA, and in Program 2" dedup), but bars them from
 * a *different* cert's slot (the §4/§6 contention). See `allocateCandidates`,
 * which is pure and unit-testable.
 */

import prisma from "@/lib/prisma";
import { addMonths } from "@/lib/utils";
import {
  getEmailSetsByTitle,
  resolveSiblingTitles,
  countriesInRegion,
  type ComplianceScope,
} from "@/lib/program-compliance";

// ─── Public types ────────────────────────────────────────────────────────────

export type CandidateTier = "easy-win" | "lapsed" | "legacy" | "net-new";

/** How the whole plan is targeted for one program. */
export interface PlanTarget {
  program: string;
  mode: "tier" | "specialisations" | "all";
  /** Set when mode === "tier". */
  tier?: string;
  /** Set when mode === "specialisations". */
  specialisations?: string[];
}

export interface CompliancePlanInput {
  targets: PlanTarget[];
  /** "global" | "theatre" | "region" | "country" — the selected plan scope. */
  level: string;
  country: string;
  region: string;
  theatre: string;
  companyIds: number[] | null;
  /** 0 disables the renewal overlay; otherwise 1 | 3 | 6 | 12 months. */
  renewalWindowMonths: number;
}

/** One geography-scoped instance of a program requirement (a distinct gap). */
export interface PlanRequirement {
  instanceId: string;
  specialisation: string | null;
  tierName: string | null;
  purpose: string;
  /** Country | Theatre | Global — the requirement's authored (native) level. */
  nativeLevel: string;
  /** The population label this instance is counted over, e.g. "UK" / "EMEA" / "Global". */
  scopeLabel: string;
  /** True when the requirement is authored *above* the selected scope (this scope
   *  can contribute to it but can't fully close it alone). */
  shared: boolean;
  cert: string;
  required: number;
  attained: number;
  shortfall: number;
  easyWinPool: number;
  lapsedPool: number;
  legacyPool: number;
  /** Slots still needing brand-new training after cheaper candidates are allocated. */
  netNew: number;
  /** Active holders whose qualifying training expires within the renewal window. */
  expiringSoon: number;
}

export interface PlanSpecialisation {
  name: string;
  achieved: boolean;
  /** People-moves to close this specialisation (sum of its instances' shortfall). */
  cost: number;
  easyWins: number;
  requirements: PlanRequirement[];
  /** For a tier target: chosen among the cheapest K remaining specialisations. */
  chosen?: boolean;
}

export interface PlanTargetResult {
  program: string;
  mode: "tier" | "specialisations" | "all";
  isTiered: boolean;
  tierName: string | null;
  headline: string;
  tierPlan?: {
    specialisationsRequired: number;
    alreadyAchieved: number;
    needed: number;
    deliveryCertShortfall: number;
  };
  specialisations: PlanSpecialisation[];
  peopleMoves: number;
  easyWins: number;
  netNew: number;
}

export interface PlanCandidateClose {
  program: string;
  specialisation: string | null;
  tierName: string | null;
  cert: string;
  scopeLabel: string;
  shared: boolean;
  tier: CandidateTier;
  /** ILT/OLX (easy-win) or legacy cert (legacy) full title that gets them there. */
  path: string | null;
}

export interface PlanCandidate {
  email: string;
  fullName: string;
  country: string;
  theatre: string;
  topTier: CandidateTier;
  closesCount: number;
  closes: PlanCandidateClose[];
}

export interface PlanRenewalRow {
  email: string;
  fullName: string;
  country: string;
  theatre: string;
  cert: string;
  scopeLabel: string;
}

export interface CompliancePlanResult {
  scopeLabel: string;
  renewalWindowMonths: number;
  targets: PlanTargetResult[];
  candidates: PlanCandidate[];
  renewals: PlanRenewalRow[];
  totals: {
    peopleMoves: number;
    easyWins: number;
    lapsed: number;
    legacy: number;
    netNew: number;
    renewalsAtRisk: number;
  };
}

// ─── Internal instance shape (fed to the pure allocator) ─────────────────────

interface PoolMember {
  email: string;
  tier: Exclude<CandidateTier, "net-new">;
  path: string | null;
}

/** A requirement instance with its resolved gap + candidate pools. */
interface ReqInstance {
  id: string;
  program: string;
  specialisation: string | null;
  tierName: string | null;
  purpose: string;
  nativeLevel: string;
  scopeLabel: string;
  shared: boolean;
  /** Identity of the qualifying cert-set: two instances sharing it share moves. */
  certKey: string;
  cert: string;
  required: number;
  attained: number;
  shortfall: number;
  pool: PoolMember[];
  poolEmails: Set<string>;
  expiringEmails: string[];
}

const TIER_RANK: Record<Exclude<CandidateTier, "net-new">, number> = {
  "easy-win": 0,
  lapsed: 1,
  legacy: 2,
};

// ─── Reverse ILT/OLX → cert index + legacy/full-title maps ───────────────────

interface CatalogueIndex {
  /** cert trainingTitle → the ILT/OLX titles that lead to it (with display). */
  reverseCert: Map<string, { title: string; full: string }[]>;
  /** cert trainingTitle → legacy certs whose replacedBy names it (with display). */
  legacyForCert: Map<string, { title: string; full: string }[]>;
  fullTitle: Map<string, string>;
}

async function buildCatalogueIndex(): Promise<CatalogueIndex> {
  const rows = await prisma.trainingData.findMany({
    select: {
      trainingTitle: true,
      fullTitle: true,
      trainingType: true,
      certification: true,
      isLegacy: true,
      replacedBy: true,
    },
  });

  const fullTitle = new Map<string, string>();
  for (const r of rows) fullTitle.set(r.trainingTitle, r.fullTitle);

  const reverseCert = new Map<string, { title: string; full: string }[]>();
  const legacyForCert = new Map<string, { title: string; full: string }[]>();

  for (const r of rows) {
    // ILT / OLX parents carry `certification[]` — invert it: for each cert this
    // training leads to, record this training as a path to that cert.
    if (
      (r.trainingType === "InstructorLedTraining" || r.trainingType === "OLX") &&
      r.certification.length > 0
    ) {
      for (const certTitle of r.certification) {
        if (!reverseCert.has(certTitle)) reverseCert.set(certTitle, []);
        reverseCert.get(certTitle)!.push({ title: r.trainingTitle, full: r.fullTitle });
      }
    }
    // Legacy certs point (via replacedBy) at their replacement(s) — invert it so a
    // required cert knows which legacy certs upgrade into it.
    if (r.isLegacy && r.replacedBy.length > 0) {
      for (const replacement of r.replacedBy) {
        if (!legacyForCert.has(replacement)) legacyForCert.set(replacement, []);
        legacyForCert.get(replacement)!.push({ title: r.trainingTitle, full: r.fullTitle });
      }
    }
  }

  return { reverseCert, legacyForCert, fullTitle };
}

// ─── Scope helpers ───────────────────────────────────────────────────────────

function studentWhereFromScope(scope: ComplianceScope): Record<string, unknown> | null {
  const w: Record<string, unknown> = {};
  if (scope.country) w.country = scope.country;
  if (scope.countries) w.country = { in: scope.countries };
  if (scope.theatre) w.theatre = scope.theatre;
  if (Array.isArray(scope.companyIds) && scope.companyIds.length > 0) {
    w.companyId = { in: scope.companyIds };
  }
  return Object.keys(w).length > 0 ? w : null;
}

/** Distinct emails that have *ever* held any of the given titles within scope
 *  (regardless of expiry) — the basis of the "lapsed" pool. */
async function holdersEver(titles: string[], scope: ComplianceScope): Promise<Set<string>> {
  if (titles.length === 0) return new Set();
  if (Array.isArray(scope.companyIds) && scope.companyIds.length === 0) return new Set();
  const { fetchTitles } = await resolveSiblingTitles(titles);
  const studentWhere = studentWhereFromScope(scope);
  const rows = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: fetchTitles },
      ...(studentWhere ? { student: studentWhere } : {}),
    },
    select: { email: true },
    distinct: ["email"],
  });
  return new Set(rows.map((r: { email: string }) => r.email));
}

/** Union all holder sets in a getEmailSetsByTitle result into one set. */
function unionEmails(map: Map<string, Set<string>>): Set<string> {
  const u = new Set<string>();
  for (const set of map.values()) for (const e of set) u.add(e);
  return u;
}

// ─── Geography instancing ────────────────────────────────────────────────────

interface GeoPlan {
  /** Countries to instance Country-level requirements over. */
  countries: string[];
  /** Theatres to instance Theatre-level requirements over + whether shared. */
  theatres: { theatre: string; shared: boolean }[];
  /** Whether the single Global instance is shared (selected level is below global). */
  globalShared: boolean;
  scopeLabel: string;
}

async function resolveGeoPlan(
  input: CompliancePlanInput,
  regionData: { country: string; region: string; theatre: string | null }[],
): Promise<GeoPlan> {
  const { level, country, region, theatre } = input;
  const theatreOf = new Map(regionData.map((r) => [r.country, r.theatre ?? ""]));

  if (level === "country" && country) {
    const t = theatreOf.get(country) || "";
    return {
      countries: [country],
      theatres: t ? [{ theatre: t, shared: true }] : [],
      globalShared: true,
      scopeLabel: country,
    };
  }
  if (level === "region" && region) {
    const countries = await countriesInRegion(region);
    const theatres = [...new Set(countries.map((c) => theatreOf.get(c) || "").filter(Boolean))];
    return {
      countries,
      theatres: theatres.map((t) => ({ theatre: t, shared: true })),
      globalShared: true,
      scopeLabel: region,
    };
  }
  if (level === "theatre" && theatre) {
    const countries = regionData.filter((r) => r.theatre === theatre).map((r) => r.country);
    return {
      countries,
      theatres: [{ theatre, shared: false }],
      globalShared: true,
      scopeLabel: theatre,
    };
  }
  // Global (default): instance Country reqs per country, Theatre reqs per theatre.
  const countries = regionData.map((r) => r.country);
  const theatres = [...new Set(regionData.map((r) => r.theatre ?? "").filter(Boolean))];
  return {
    countries,
    theatres: theatres.map((t) => ({ theatre: t, shared: false })),
    globalShared: false,
    scopeLabel: "Global",
  };
}

// ─── Program-data loading ────────────────────────────────────────────────────

interface RequirementRow {
  id: number;
  specialisationName: string | null;
  tierId: number | null;
  purpose: string;
  level: string;
  quantityRequired: number;
  /** Qualifying cert trainingTitles: primary + alternatives. */
  titles: string[];
  /** Display: " or "-joined full titles. */
  cert: string;
}

type ProgramDataWithRelations = {
  id: number;
  specialisationId: number | null;
  tierId: number | null;
  purpose: string;
  level: string;
  quantityRequired: number;
  trainingTitle: string | null;
  specialisation: { name: string } | null;
  trainingData: { fullTitle: string } | null;
  alternatives: { trainingTitle: string; trainingData: { fullTitle: string } | null }[];
};

function toRequirementRow(pd: ProgramDataWithRelations): RequirementRow | null {
  if (!pd.trainingTitle) return null; // count-compliant-theatres placeholder — no cert to close
  const titles = [pd.trainingTitle, ...pd.alternatives.map((a) => a.trainingTitle)];
  const fulls = [
    pd.trainingData?.fullTitle ?? pd.trainingTitle,
    ...pd.alternatives.map((a) => a.trainingData?.fullTitle ?? a.trainingTitle),
  ];
  return {
    id: pd.id,
    specialisationName: pd.specialisation?.name ?? null,
    tierId: pd.tierId,
    purpose: pd.purpose,
    level: pd.level,
    quantityRequired: pd.quantityRequired,
    titles,
    cert: [...new Set(fulls)].join(" or "),
  };
}

// ─── Instance building (gap + pools) ─────────────────────────────────────────

/** Build every geography-scoped instance of a requirement row, resolving its gap
 *  and candidate pools. Pools are only computed for instances that have a gap. */
async function buildInstances(
  program: string,
  row: RequirementRow,
  geo: GeoPlan,
  input: CompliancePlanInput,
  idx: CatalogueIndex,
  now: Date,
  horizon: Date | null,
): Promise<ReqInstance[]> {
  const companyIds = input.companyIds;
  const certKey = [...row.titles].sort().join("|");

  const targets: { scope: ComplianceScope; scopeLabel: string; shared: boolean }[] = [];
  if (row.level === "Country") {
    for (const c of geo.countries) {
      targets.push({ scope: { country: c, companyIds }, scopeLabel: c, shared: false });
    }
  } else if (row.level === "Theatre") {
    for (const t of geo.theatres) {
      targets.push({ scope: { theatre: t.theatre, companyIds }, scopeLabel: t.theatre, shared: t.shared });
    }
  } else if (row.level === "Global") {
    targets.push({ scope: { companyIds }, scopeLabel: "Global", shared: geo.globalShared });
  }

  const instances: ReqInstance[] = [];
  for (const t of targets) {
    const activeMap = await getEmailSetsByTitle(row.titles, now, t.scope);
    const active = unionEmails(activeMap);
    const attained = active.size;
    const shortfall = Math.max(0, row.quantityRequired - attained);

    // Renewal overlay: active holders who will drop out by the horizon.
    let expiringEmails: string[] = [];
    if (horizon && attained > 0) {
      const futureMap = await getEmailSetsByTitle(row.titles, horizon, t.scope);
      const future = unionEmails(futureMap);
      expiringEmails = [...active].filter((e) => !future.has(e));
    }

    const pool: PoolMember[] = [];
    const seen = new Map<string, PoolMember>();
    if (shortfall > 0) {
      // easy-win: holders of an ILT/OLX that leads to any qualifying cert.
      const iltTitles: string[] = [];
      const iltFullFor = new Map<string, string>();
      for (const cert of row.titles) {
        for (const ilt of idx.reverseCert.get(cert) ?? []) {
          iltTitles.push(ilt.title);
          if (!iltFullFor.has(ilt.title)) iltFullFor.set(ilt.title, ilt.full);
        }
      }
      if (iltTitles.length > 0) {
        const iltMap = await getEmailSetsByTitle([...new Set(iltTitles)], now, t.scope);
        for (const [title, set] of iltMap) {
          const path = iltFullFor.get(title) ?? null;
          for (const email of set) {
            if (active.has(email)) continue;
            addPool(seen, { email, tier: "easy-win", path });
          }
        }
      }

      // lapsed: ever-held minus currently-active.
      const ever = await holdersEver(row.titles, t.scope);
      for (const email of ever) {
        if (active.has(email)) continue;
        addPool(seen, { email, tier: "lapsed", path: null });
      }

      // legacy: active holders of a legacy cert that upgrades into a qualifying cert.
      const legacyTitles: string[] = [];
      const legacyFullFor = new Map<string, string>();
      for (const cert of row.titles) {
        for (const lg of idx.legacyForCert.get(cert) ?? []) {
          legacyTitles.push(lg.title);
          if (!legacyFullFor.has(lg.title)) legacyFullFor.set(lg.title, lg.full);
        }
      }
      if (legacyTitles.length > 0) {
        const lgMap = await getEmailSetsByTitle([...new Set(legacyTitles)], now, t.scope);
        for (const [title, set] of lgMap) {
          const path = legacyFullFor.get(title) ?? null;
          for (const email of set) {
            if (active.has(email)) continue;
            addPool(seen, { email, tier: "legacy", path });
          }
        }
      }
      pool.push(...seen.values());
    }

    instances.push({
      id: `${program}::${row.id}::${t.scopeLabel}`,
      program,
      specialisation: row.specialisationName,
      tierName: null,
      purpose: row.purpose,
      nativeLevel: row.level,
      scopeLabel: t.scopeLabel,
      shared: t.shared,
      certKey,
      cert: row.cert,
      required: row.quantityRequired,
      attained,
      shortfall,
      pool,
      poolEmails: new Set(pool.map((p) => p.email)),
      expiringEmails,
    });
  }
  return instances;
}

/** Keep the cheapest tier per email in a pool. */
function addPool(seen: Map<string, PoolMember>, m: PoolMember): void {
  const existing = seen.get(m.email);
  if (!existing || TIER_RANK[m.tier] < TIER_RANK[existing.tier]) seen.set(m.email, m);
}

// ─── Pure greedy allocation ──────────────────────────────────────────────────

export interface AllocationResult {
  /** email → the ordered closes it was assigned. */
  closesByEmail: Map<string, PlanCandidateClose[]>;
  /** email → the tier it committed at (its cert's cheapest tier). */
  committedTier: Map<string, Exclude<CandidateTier, "net-new">>;
  /** instanceId → net-new slots still open after allocation. */
  netNewByInstance: Map<string, number>;
}

/**
 * Greedy candidate allocation across the whole target (v1).
 *
 * A "move" is a person earning one cert (identified by `certKey`). Committing a
 * person to a cert credits every instance needing that *same* cert whose pool
 * contains them (same-cert, multi-geography dedup) but bars them from a
 * *different* cert's slot (contention — one move can't grant two different certs).
 *
 * Greedy heuristics, flagged so a future pass can swap in bipartite matching /
 * set-cover if it ever matters:
 *  - process instances closest to done first (smallest shortfall), so scarce
 *    easy people aren't burned on the largest gaps;
 *  - within an instance prefer cheaper tiers, then higher-coverage people (those
 *    whose one move closes the most same-cert instances).
 */
export function allocateCandidates(instances: ReqInstance[]): AllocationResult {
  const open = instances.filter((i) => i.shortfall > 0);

  const byCertKey = new Map<string, ReqInstance[]>();
  for (const inst of open) {
    if (!byCertKey.has(inst.certKey)) byCertKey.set(inst.certKey, []);
    byCertKey.get(inst.certKey)!.push(inst);
  }

  // Coverage of an (email, certKey): how many open same-cert instances it serves.
  const coverage = new Map<string, number>();
  const covKey = (email: string, certKey: string) => `${email} ${certKey}`;
  for (const [certKey, insts] of byCertKey) {
    const counts = new Map<string, number>();
    for (const inst of insts) {
      for (const email of inst.poolEmails) counts.set(email, (counts.get(email) ?? 0) + 1);
    }
    for (const [email, n] of counts) coverage.set(covKey(email, certKey), n);
  }

  const committedCert = new Map<string, string>(); // email → certKey
  const committedTier = new Map<string, Exclude<CandidateTier, "net-new">>();
  const filled = new Map<string, number>();
  const closesByEmail = new Map<string, PlanCandidateClose[]>();

  const record = (email: string, inst: ReqInstance, member: PoolMember) => {
    if (!closesByEmail.has(email)) closesByEmail.set(email, []);
    closesByEmail.get(email)!.push({
      program: inst.program,
      specialisation: inst.specialisation,
      tierName: inst.tierName,
      cert: inst.cert,
      scopeLabel: inst.scopeLabel,
      shared: inst.shared,
      tier: member.tier,
      path: member.path,
    });
  };

  const ordered = [...open].sort((a, b) => {
    if (a.shared !== b.shared) return a.shared ? 1 : -1; // fill closable-alone gaps first
    return a.shortfall - b.shortfall;
  });

  for (const inst of ordered) {
    let have = filled.get(inst.id) ?? 0;
    if (have >= inst.shortfall) continue;

    const cands = [...inst.pool].sort((a, b) => {
      const tr = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (tr !== 0) return tr;
      return (
        (coverage.get(covKey(b.email, inst.certKey)) ?? 0) -
        (coverage.get(covKey(a.email, inst.certKey)) ?? 0)
      );
    });

    for (const cand of cands) {
      if (have >= inst.shortfall) break;
      const already = committedCert.get(cand.email);
      if (already && already !== inst.certKey) continue; // spent on a different cert

      if (!already) {
        committedCert.set(cand.email, inst.certKey);
        committedTier.set(cand.email, cand.tier);
      }

      // Credit this move to every open same-cert instance that can use them.
      for (const other of byCertKey.get(inst.certKey)!) {
        if ((filled.get(other.id) ?? 0) >= other.shortfall) continue;
        const m = other.pool.find((p) => p.email === cand.email);
        if (!m) continue;
        filled.set(other.id, (filled.get(other.id) ?? 0) + 1);
        record(cand.email, other, m);
      }
      have = filled.get(inst.id) ?? 0;
    }
  }

  const netNewByInstance = new Map<string, number>();
  for (const inst of instances) {
    netNewByInstance.set(inst.id, Math.max(0, inst.shortfall - (filled.get(inst.id) ?? 0)));
  }

  return { closesByEmail, committedTier, netNewByInstance };
}

// ─── Tier fastest-path ───────────────────────────────────────────────────────

interface TierInfo {
  id: number;
  name: string;
  sortOrder: number;
  specialisationsRequired: number;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function computeCompliancePlan(input: CompliancePlanInput): Promise<CompliancePlanResult> {
  const now = new Date();
  const horizon = input.renewalWindowMonths > 0 ? addMonths(now, input.renewalWindowMonths) : null;

  const [idx, regionData] = await Promise.all([
    buildCatalogueIndex(),
    prisma.regionData.findMany({ orderBy: { country: "asc" }, select: { country: true, region: true, theatre: true } }),
  ]);
  const geo = await resolveGeoPlan(input, regionData);

  const targets: PlanTargetResult[] = [];
  const allInstances: ReqInstance[] = [];
  // Per-target list of the instances that belong to it (for post-allocation rollup).
  const targetInstanceIds: { target: PlanTargetResult; instanceIds: string[] }[] = [];

  for (const target of input.targets) {
    const [programRow, programData, tierRows] = await Promise.all([
      prisma.program.findUnique({ where: { name: target.program }, select: { isTiered: true } }),
      prisma.programData.findMany({
        where: { programName: target.program },
        select: {
          id: true,
          specialisationId: true,
          tierId: true,
          purpose: true,
          level: true,
          quantityRequired: true,
          trainingTitle: true,
          specialisation: { select: { name: true } },
          trainingData: { select: { fullTitle: true } },
          alternatives: { select: { trainingTitle: true, trainingData: { select: { fullTitle: true } } } },
        },
      }),
      prisma.programTier.findMany({
        where: { programName: target.program },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, sortOrder: true, specialisationsRequired: true },
      }),
    ]);

    const isTiered = programRow?.isTiered === true;
    const rows = programData
      .map(toRequirementRow)
      .filter((r): r is RequirementRow => r !== null);

    // Which requirement rows are in play for this target's mode.
    const chosenTier: TierInfo | null =
      target.mode === "tier" && target.tier
        ? tierRows.find((t) => t.name === target.tier) ?? null
        : null;

    let activeRows: RequirementRow[];
    let restrictSpecs: Set<string> | null = null;
    if (target.mode === "specialisations" && target.specialisations && target.specialisations.length > 0) {
      restrictSpecs = new Set(target.specialisations);
      activeRows = rows.filter((r) => r.specialisationName && restrictSpecs!.has(r.specialisationName));
    } else if (target.mode === "tier") {
      // Tier target: all specialisation qualifying rows (to rank the cheapest K)
      // plus this tier's deployment rows.
      activeRows = rows.filter(
        (r) =>
          (r.specialisationName && r.purpose === "qualification") ||
          (chosenTier && r.tierId === chosenTier.id),
      );
    } else {
      activeRows = rows; // "all"
    }

    // Build instances for every active row.
    const rowInstances: ReqInstance[] = [];
    for (const row of activeRows) {
      const built = await buildInstances(target.program, row, geo, input, idx, now, horizon);
      // Tag tier-deployment instances with the tier name for display.
      if (chosenTier && row.tierId === chosenTier.id) {
        for (const b of built) b.tierName = chosenTier.name;
      }
      rowInstances.push(...built);
    }
    allInstances.push(...rowInstances);

    const targetResult: PlanTargetResult = {
      program: target.program,
      mode: target.mode,
      isTiered,
      tierName: chosenTier?.name ?? null,
      headline: "",
      specialisations: [],
      peopleMoves: 0,
      easyWins: 0,
      netNew: 0,
    };
    if (chosenTier) {
      targetResult.tierPlan = {
        specialisationsRequired: chosenTier.specialisationsRequired,
        alreadyAchieved: 0,
        needed: 0,
        deliveryCertShortfall: 0,
      };
    }
    targets.push(targetResult);
    targetInstanceIds.push({ target: targetResult, instanceIds: rowInstances.map((i) => i.id) });
  }

  // Greedy allocation across ALL instances of ALL targets at once (contention is
  // global — a person spent in Program A can't also be spent in Program B).
  const alloc = allocateCandidates(allInstances);
  const instById = new Map(allInstances.map((i) => [i.id, i]));

  // Student display info for every committed candidate + every renewal-at-risk holder.
  const candidateEmails = new Set<string>(alloc.closesByEmail.keys());
  for (const inst of allInstances) for (const e of inst.expiringEmails) candidateEmails.add(e);
  const students = candidateEmails.size > 0
    ? await prisma.student.findMany({
        where: { email: { in: [...candidateEmails] } },
        select: { email: true, fullName: true, country: true, theatre: true },
      })
    : [];
  const studentById = new Map(students.map((s) => [s.email, s]));

  // ── Roll instances back up into the per-target roadmap ──
  for (const { target, instanceIds } of targetInstanceIds) {
    const insts = instanceIds.map((id) => instById.get(id)!).filter(Boolean);
    const bySpec = new Map<string, ReqInstance[]>();
    const tierDeployInsts: ReqInstance[] = [];
    for (const inst of insts) {
      if (inst.tierName && !inst.specialisation) {
        tierDeployInsts.push(inst);
        continue;
      }
      const key = inst.specialisation ?? "—";
      if (!bySpec.has(key)) bySpec.set(key, []);
      bySpec.get(key)!.push(inst);
    }

    const specs: PlanSpecialisation[] = [];
    for (const [name, specInsts] of bySpec) {
      const requirements = specInsts.map((inst) => toPlanRequirement(inst, alloc));
      const cost = requirements.reduce((s, r) => s + r.shortfall, 0);
      const easyWins = specInsts.reduce(
        (s, inst) => s + inst.pool.filter((p) => p.tier === "easy-win").length,
        0,
      );
      const achieved = requirements.every((r) => r.shortfall === 0);
      specs.push({ name, achieved, cost, easyWins, requirements });
    }
    specs.sort((a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name));

    // Tier fastest-path: pick the cheapest K not-yet-achieved specialisations.
    if (target.tierPlan) {
      const achievedCount = specs.filter((s) => s.achieved).length;
      const needed = Math.max(0, target.tierPlan.specialisationsRequired - achievedCount);
      target.tierPlan.alreadyAchieved = achievedCount;
      target.tierPlan.needed = needed;
      const remaining = specs.filter((s) => !s.achieved);
      for (let i = 0; i < remaining.length; i++) {
        remaining[i].chosen = i < needed;
      }
      target.tierPlan.deliveryCertShortfall = tierDeployInsts.reduce(
        (s, inst) => s + inst.shortfall,
        0,
      );
      // Surface tier deployment requirements as a synthetic specialisation block.
      if (tierDeployInsts.length > 0) {
        specs.push({
          name: `${target.tierName} — delivery certs`,
          achieved: tierDeployInsts.every((i) => (i.shortfall) === 0),
          cost: tierDeployInsts.reduce((s, i) => s + i.shortfall, 0),
          easyWins: tierDeployInsts.reduce((s, i) => s + i.pool.filter((p) => p.tier === "easy-win").length, 0),
          requirements: tierDeployInsts.map((inst) => toPlanRequirement(inst, alloc)),
          chosen: true,
        });
      }
    }

    target.specialisations = specs;

    // Per-target totals: distinct committed people whose close touches this target,
    // plus its net-new slots.
    const targetEmails = new Set<string>();
    let easyWins = 0;
    for (const [email, closes] of alloc.closesByEmail) {
      if (closes.some((c) => c.program === target.program)) {
        targetEmails.add(email);
        if (alloc.committedTier.get(email) === "easy-win") easyWins++;
      }
    }
    const netNew = insts.reduce((s, inst) => s + (alloc.netNewByInstance.get(inst.id) ?? 0), 0);
    target.easyWins = easyWins;
    target.netNew = netNew;
    target.peopleMoves = targetEmails.size + netNew;
    target.headline = buildHeadline(target, geo.scopeLabel);
  }

  // ── Candidate-centric drill-down ──
  const candidates: PlanCandidate[] = [];
  for (const [email, closes] of alloc.closesByEmail) {
    const s = studentById.get(email);
    const topTier = alloc.committedTier.get(email) ?? "easy-win";
    // easy-wins float to the top of each person's close list.
    const sortedCloses = [...closes].sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier));
    candidates.push({
      email,
      fullName: s?.fullName ?? email,
      country: s?.country ?? "",
      theatre: s?.theatre ?? "",
      topTier,
      closesCount: closes.length,
      closes: sortedCloses,
    });
  }
  candidates.sort(
    (a, b) => tierOrder(a.topTier) - tierOrder(b.topTier) || b.closesCount - a.closesCount || a.fullName.localeCompare(b.fullName),
  );

  // ── Renewal-at-risk rows (deduped by email+cert+scope) ──
  const renewals: PlanRenewalRow[] = [];
  const renewalSeen = new Set<string>();
  const renewalEmails = new Set<string>();
  for (const inst of allInstances) {
    for (const email of inst.expiringEmails) {
      const k = `${email} ${inst.cert} ${inst.scopeLabel}`;
      if (renewalSeen.has(k)) continue;
      renewalSeen.add(k);
      renewalEmails.add(email);
      const s = studentById.get(email);
      renewals.push({
        email,
        fullName: s?.fullName ?? email,
        country: s?.country ?? "",
        theatre: s?.theatre ?? "",
        cert: inst.cert,
        scopeLabel: inst.scopeLabel,
      });
    }
  }
  renewals.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.cert.localeCompare(b.cert));

  // ── Overall totals ──
  let easyWins = 0;
  let lapsed = 0;
  let legacy = 0;
  for (const tier of alloc.committedTier.values()) {
    if (tier === "easy-win") easyWins++;
    else if (tier === "lapsed") lapsed++;
    else legacy++;
  }
  const netNew = [...alloc.netNewByInstance.values()].reduce((s, n) => s + n, 0);

  return {
    scopeLabel: geo.scopeLabel,
    renewalWindowMonths: input.renewalWindowMonths,
    targets,
    candidates,
    renewals,
    totals: {
      peopleMoves: alloc.closesByEmail.size + netNew,
      easyWins,
      lapsed,
      legacy,
      netNew,
      renewalsAtRisk: renewalEmails.size,
    },
  };
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function tierOrder(t: CandidateTier): number {
  return t === "easy-win" ? 0 : t === "lapsed" ? 1 : t === "legacy" ? 2 : 3;
}

function toPlanRequirement(inst: ReqInstance, alloc: AllocationResult): PlanRequirement {
  return {
    instanceId: inst.id,
    specialisation: inst.specialisation,
    tierName: inst.tierName,
    purpose: inst.purpose,
    nativeLevel: inst.nativeLevel,
    scopeLabel: inst.scopeLabel,
    shared: inst.shared,
    cert: inst.cert,
    required: inst.required,
    attained: inst.attained,
    shortfall: inst.shortfall,
    easyWinPool: inst.pool.filter((p) => p.tier === "easy-win").length,
    lapsedPool: inst.pool.filter((p) => p.tier === "lapsed").length,
    legacyPool: inst.pool.filter((p) => p.tier === "legacy").length,
    netNew: alloc.netNewByInstance.get(inst.id) ?? 0,
    expiringSoon: inst.expiringEmails.length,
  };
}

function buildHeadline(target: PlanTargetResult, scopeLabel: string): string {
  const where = scopeLabel === "Global" ? "globally" : `in ${scopeLabel}`;
  if (target.peopleMoves === 0) {
    return `${target.program} is fully compliant ${where} — no moves needed.`;
  }
  const easy = target.easyWins > 0 ? `, ${target.easyWins} of them easy wins` : "";
  if (target.tierPlan && target.tierName) {
    const { needed, deliveryCertShortfall } = target.tierPlan;
    const parts: string[] = [];
    if (needed > 0) {
      const chosen = target.specialisations.filter((s) => s.chosen && !s.name.endsWith("delivery certs"));
      const names = chosen.map((s) => `${s.name} (${s.cost} move${s.cost === 1 ? "" : "s"}${s.easyWins > 0 ? `, ${s.easyWins} easy` : ""})`);
      parts.push(`achieve ${needed} more specialisation${needed === 1 ? "" : "s"}${names.length ? ` — cheapest are ${names.join(", ")}` : ""}`);
    }
    if (deliveryCertShortfall > 0) parts.push(`${deliveryCertShortfall} more delivery cert${deliveryCertShortfall === 1 ? "" : "s"}`);
    const body = parts.length > 0 ? parts.join(", plus ") : "close the remaining gaps";
    return `To reach ${target.tierName} ${where}: ${body}. ~${target.peopleMoves} people-moves${easy}.`;
  }
  return `${target.program} ${where}: ~${target.peopleMoves} people-moves to close all gaps${easy}.`;
}
