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
 *   0. renewal         — holds the cert today but it expires inside the renewal
 *                        window. Only in play when the caller asks to *plan for*
 *                        that window (`planForWindow`); otherwise these people
 *                        still count as attained and sit in no pool.
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
 * needs *that same cert* over a population containing them (the "one exam closes
 * Cert X in Program A and in Program B" dedup), but bars them from a *different*
 * cert's slot (contention). See `allocateCandidates`, which is pure and
 * unit-testable.
 *
 * **The same dedup governs the net-new remainder**, and that is easy to lose: a
 * cert required by three specialisations at 2 each, with nobody in its pools, is
 * *two* people to certify, not six. `netNewTotal` therefore groups instances by
 * cert + population and takes the largest remaining gap per group rather than
 * summing. Only the totals dedup — `PlanRequirement.netNew` and
 * `PlanSpecialisation.cost` stay per-instance/standalone, because each of those
 * figures is true of that requirement read on its own, and `sharedWith` names the
 * other specialisations so the page can say the total counts it once. The same
 * dedup decides a tiered target's cheapest-K specialisations: `specSetCost` costs
 * a *set* rather than each member, and the ranking picks greedily by what each
 * candidate adds to the set so far, so two specialisations sharing a cert rank as
 * the bargain they are. Greedy, not exact — picking the genuinely cheapest set is
 * set cover — but the approximation is now in the search, not in the cost.
 */

import prisma from "@/lib/prisma";
import { ELIGIBLE_TRAINING_DATA } from "@/lib/reportable-training";
import { addMonths } from "@/lib/utils";
import {
  getEmailSetsByTitle,
  resolveSiblingTitles,
  countriesInRegion,
  type ComplianceScope,
} from "@/lib/program-compliance";

// ─── Public types ────────────────────────────────────────────────────────────

export type CandidateTier = "renewal" | "easy-win" | "lapsed" | "legacy" | "net-new";

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
  /**
   * Plan *for* the renewal window rather than just reporting it: gaps are sized
   * from the projected (end-of-window) holder count, so training that lapses
   * inside the window has to be renewed to count as closed. Ignored when
   * `renewalWindowMonths` is 0.
   */
  planForWindow: boolean;
}

/** One geography-scoped instance of a program requirement (a distinct gap). */
export interface PlanRequirement {
  instanceId: string;
  specialisation: string | null;
  tierName: string | null;
  purpose: string;
  /** Country | Theatre | Global — the requirement's authored (native) level. */
  nativeLevel: string;
  /** The population label this instance is counted over, e.g. "UK" / "Global". */
  scopeLabel: string;
  cert: string;
  required: number;
  attained: number;
  /**
   * Distinct holders still active at the end of the renewal window. `null` when
   * no window is selected. Note this is a fresh point-in-time count, not
   * `attained - expiringSoon` — someone whose completion lands inside the window
   * is counted here but not in `attained`.
   */
  projectedAttained: number | null;
  /** The gap today: `required - attained`. Independent of `planForWindow`. */
  shortfall: number;
  /** The gap at the end of the window. `null` when no window is selected. */
  projectedShortfall: number | null;
  /** Only non-zero when planning for the renewal window (see `CandidateTier`). */
  renewalPool: number;
  easyWinPool: number;
  lapsedPool: number;
  legacyPool: number;
  /**
   * Slots still needing brand-new training after cheaper candidates are allocated.
   * Per instance, so it reads true of this requirement alone — the plan's totals
   * count a cert shared with `sharedWith` once (see `netNewTotal`).
   */
  netNew: number;
  /**
   * The other specialisations in this target that need the same cert over the same
   * population. Non-empty means this requirement's `netNew`/gap is shared: closing
   * it closes theirs too, and the target's totals charge for it once.
   */
  sharedWith: string[];
  /** Active holders whose qualifying training expires within the renewal window. */
  expiringSoon: number;
}

export interface PlanSpecialisation {
  name: string;
  /** Every requirement met *today*. Independent of `planForWindow`. */
  achieved: boolean;
  /**
   * Every requirement still met at the end of the renewal window. `null` when no
   * window is selected. `achieved && projectedAchieved === false` is the "at
   * risk" state — compliant now, not compliant then.
   */
  projectedAchieved: boolean | null;
  /** People-moves to close this specialisation (sum of its instances' shortfall). */
  cost: number;
  easyWins: number;
  requirements: PlanRequirement[];
  /** For a tier target: one of the `needed` specialisations this plan actually
   *  costed against — the cheapest set by marginal cost, so exactly `needed` of
   *  them are flagged and their `marginalCost`s sum to the target's people-moves. */
  chosen?: boolean;
  /** For a tier target: not counted, but swapping it in for one of the chosen
   *  specialisations would cost no more. Shown so a genuine alternative isn't
   *  hidden by the arbitrary pick between two equal paths. */
  alternative?: boolean;
  /** For a tier target: what this specialisation adds *on top of the other chosen
   *  ones* — equal to `cost` unless it shares a certification with them, in which
   *  case the shared cert is already paid for. Set for chosen and alternative
   *  specialisations only. */
  marginalCost?: number;
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

/** One requirement that falls below target as training expires in the window. */
export interface PlanRiskImpact {
  program: string;
  specialisation: string | null;
  tierName: string | null;
  cert: string;
  scopeLabel: string;
  required: number;
  attained: number;
  projectedAttained: number;
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
  /** Echo of the input flag, so the client knows which basis this payload used. */
  planForWindow: boolean;
  targets: PlanTargetResult[];
  candidates: PlanCandidate[];
  /**
   * The full eligible pool — everyone in any counted requirement's candidate
   * pool (all tiers), deduped by person, each with the gaps they *could*
   * contribute to. A superset of `candidates`, which is only the cheapest
   * subset the allocator nominates to close the gaps.
   */
  eligible: PlanCandidate[];
  renewals: PlanRenewalRow[];
  /**
   * The requirements those renewals break. Scoped to counted instances, so it
   * always agrees with `renewals` — see the note where it's built.
   */
  riskImpacts: PlanRiskImpact[];
  totals: {
    peopleMoves: number;
    easyWins: number;
    lapsed: number;
    legacy: number;
    netNew: number;
    /** People nominated to renew (0 unless planning for the window). */
    renewalMoves: number;
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
  /** Identity of the qualifying cert-set: two instances sharing it share moves. */
  certKey: string;
  cert: string;
  required: number;
  attained: number;
  /** Holders still active at the horizon; null when no renewal window is set. */
  projectedAttained: number | null;
  /** Gap today. */
  shortfallNow: number;
  /** Gap at the horizon; null when no renewal window is set. */
  shortfallProjected: number | null;
  /**
   * THE planning gap — the single value the allocator, specialisation cost and
   * tier cheapest-path selection all cost against. Equals `shortfallNow` unless
   * we're planning for the renewal window.
   */
  shortfall: number;
  pool: PoolMember[];
  poolEmails: Set<string>;
  expiringEmails: string[];
}

const TIER_RANK: Record<Exclude<CandidateTier, "net-new">, number> = {
  // A renewal is the cheapest possible move: they already hold the training and
  // only need to re-sit it before it lapses.
  renewal: -1,
  "easy-win": 0,
  lapsed: 1,
  legacy: 2,
};

// ─── Reverse ILT/OLX → cert index + legacy/full-title maps ───────────────────

interface CatalogueIndex {
  /**
   * cert PAIR KEY → the ILT/OLX titles that lead to it (with display).
   *
   * Keyed on the pair rather than the raw `trainingTitle` for the same reason
   * `certKey` is (see `pairKey` below): `certification[]` names one catalogue
   * variant, a requirement names another, and `resolveSiblingTitles` counts them
   * as the same cert. Keying raw meant a training that led to variant A was
   * never offered as a path to a requirement naming variant B, so those
   * candidates silently fell out of the easy-win pool.
   */
  reverseCert: Map<string, { title: string; full: string }[]>;
  /** cert PAIR KEY → legacy certs whose replacedBy names it (with display). */
  legacyForCert: Map<string, { title: string; full: string }[]>;
  fullTitle: Map<string, string>;
  /**
   * trainingTitle → `${fullTitle}::${trainingType}` — the identity `certKey` is
   * built from. It must be this pair and not the raw title, because that is what
   * `resolveSiblingTitles` groups on: two requirements naming different catalogue
   * variants of one training count the *same* holders, so they have to be
   * recognised as the same cert or neither the candidate dedup nor `netNewTotal`
   * will collapse them.
   */
  pairKey: Map<string, string>;
}

async function buildCatalogueIndex(): Promise<CatalogueIndex> {
  const rows = await prisma.trainingData.findMany({
    // Unreviewed imports can't satisfy either index (they have no
    // certification[] and aren't legacy), so this is defensive rather than a
    // fix — but it keeps the whole-catalogue read consistent with every other
    // reporting path. See reportable-training.ts.
    where: ELIGIBLE_TRAINING_DATA,
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
  const pairKey = new Map<string, string>();
  for (const r of rows) {
    fullTitle.set(r.trainingTitle, r.fullTitle);
    pairKey.set(r.trainingTitle, `${r.fullTitle}::${r.trainingType}`);
  }

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
        const key = pairKey.get(certTitle) ?? certTitle;
        if (!reverseCert.has(key)) reverseCert.set(key, []);
        reverseCert.get(key)!.push({ title: r.trainingTitle, full: r.fullTitle });
      }
    }
    // Legacy certs point (via replacedBy) at their replacement(s) — invert it so a
    // required cert knows which legacy certs upgrade into it.
    if (r.isLegacy && r.replacedBy.length > 0) {
      for (const replacement of r.replacedBy) {
        const key = pairKey.get(replacement) ?? replacement;
        if (!legacyForCert.has(key)) legacyForCert.set(key, []);
        legacyForCert.get(key)!.push({ title: r.trainingTitle, full: r.fullTitle });
      }
    }
  }

  return { reverseCert, legacyForCert, fullTitle, pairKey };
}

// ─── Scope helpers ───────────────────────────────────────────────────────────

function studentWhereFromScope(scope: ComplianceScope): Record<string, unknown> | null {
  const w: Record<string, unknown> = {};
  if (scope.country) w.country = scope.country;
  if (scope.countries) w.country = { in: scope.countries };
  if (scope.theatre) w.theatre = scope.theatre;
  // `[]` means "no accessible companies" and must match nothing, so the test is
  // plain truthiness rather than `length > 0`: an empty array is truthy and
  // yields `in: []`. `null`/`undefined` remains "unrestricted". The one caller
  // guards on an empty scope already; this makes the helper itself fail closed.
  if (scope.companyIds) {
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

/**
 * The single requirement level + population a selected scope plans against.
 *
 * This mirrors the program dashboards (`lib/program-report.ts`): each scope
 * shows only the requirements authored at its own level, counted over one
 * population. Planning a country shows Country requirements over that country —
 * NOT the theatre-wide requirement above it (select the theatre to see that).
 * A region rolls its countries into one Country-level population, exactly like
 * the dashboard's region view.
 */
interface GeoPlan {
  /** Which requirement `level` this scope plans against. */
  reqLevel: "Country" | "Theatre" | "Global";
  /** The single population these requirements are counted over. */
  scope: ComplianceScope;
  scopeLabel: string;
}

async function resolveGeoPlan(
  input: CompliancePlanInput,
): Promise<GeoPlan> {
  const { level, country, region, theatre, companyIds } = input;

  if (level === "country" && country) {
    return { reqLevel: "Country", scope: { country, companyIds }, scopeLabel: country };
  }
  if (level === "region" && region) {
    const countries = await countriesInRegion(region);
    return { reqLevel: "Country", scope: { countries, companyIds }, scopeLabel: region };
  }
  if (level === "theatre" && theatre) {
    return { reqLevel: "Theatre", scope: { theatre, companyIds }, scopeLabel: theatre };
  }
  // Global (default): Global-level requirements over the whole population.
  return { reqLevel: "Global", scope: { companyIds }, scopeLabel: "Global" };
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

/** Build the requirement's single scoped instance, resolving its gap and
 *  candidate pools. Only requirements authored at the selected scope's level are
 *  in play (mirroring the program dashboards) — others return no instance.
 *  Pools are only computed when there's a gap. */
async function buildInstances(
  program: string,
  row: RequirementRow,
  geo: GeoPlan,
  idx: CatalogueIndex,
  now: Date,
  horizon: Date | null,
  planForWindow: boolean,
): Promise<ReqInstance[]> {
  // Only this scope's own-level requirements are planned against.
  if (row.level !== geo.reqLevel) return [];
  // Identity of the qualifying cert-set, keyed on what is actually *counted*:
  // the (fullTitle, trainingType) groups `resolveSiblingTitles` expands to, not
  // the authored titles. A title with no catalogue row stays a singleton, which
  // is `resolveSiblingTitles`' own fallback.
  const certKey = [...new Set(row.titles.map((t) => idx.pairKey.get(t) ?? t))].sort().join("|");

  const targets: { scope: ComplianceScope; scopeLabel: string }[] = [
    { scope: geo.scope, scopeLabel: geo.scopeLabel },
  ];

  const instances: ReqInstance[] = [];
  for (const t of targets) {
    const activeMap = await getEmailSetsByTitle(row.titles, now, t.scope);
    const active = unionEmails(activeMap);
    const attained = active.size;

    // Renewal overlay: the same count taken at the horizon, plus the active
    // holders who drop out before it. With no holders today there is nothing to
    // lose, so we skip the query and call the projection 0 — an under-count only
    // if someone's completion lands inside the window, which can never invent a
    // false "at risk".
    let expiringEmails: string[] = [];
    let projectedAttained: number | null = null;
    if (horizon) {
      if (attained === 0) {
        projectedAttained = 0;
      } else {
        const futureMap = await getEmailSetsByTitle(row.titles, horizon, t.scope);
        const future = unionEmails(futureMap);
        projectedAttained = future.size;
        expiringEmails = [...active].filter((e) => !future.has(e));
      }
    }

    const shortfallNow = Math.max(0, row.quantityRequired - attained);
    const shortfallProjected =
      projectedAttained === null ? null : Math.max(0, row.quantityRequired - projectedAttained);

    // Planning *for* the window means closing the gap now AND still holding it at
    // the horizon — hence the max, not just the projected figure (a completion
    // landing inside the window must not discount a gap that is real today).
    // Every downstream consumer of `shortfall` (pools, the allocator, spec cost,
    // tier cheapest-path selection) then follows without further plumbing.
    const shortfall =
      planForWindow && shortfallProjected !== null
        ? Math.max(shortfallNow, shortfallProjected)
        : shortfallNow;

    const pool: PoolMember[] = [];
    const seen = new Map<string, PoolMember>();
    if (shortfall > 0) {
      // renewal: holders who lapse inside the window. They're excluded from every
      // other pool below (all skip `active`), so there's nothing to double-count.
      if (planForWindow) {
        for (const email of expiringEmails) addPool(seen, { email, tier: "renewal", path: null });
      }

      // easy-win: holders of an ILT/OLX that leads to any qualifying cert.
      const iltTitles: string[] = [];
      const iltFullFor = new Map<string, string>();
      for (const cert of row.titles) {
        for (const ilt of idx.reverseCert.get(idx.pairKey.get(cert) ?? cert) ?? []) {
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
        for (const lg of idx.legacyForCert.get(idx.pairKey.get(cert) ?? cert) ?? []) {
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
      certKey,
      cert: row.cert,
      required: row.quantityRequired,
      attained,
      projectedAttained,
      shortfallNow,
      shortfallProjected,
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
 * contains them (same-cert dedup across targets/programs) but bars them from a
 * *different* cert's slot (contention — one move can't grant two different certs).
 *
 * Greedy heuristics, flagged so a future pass can swap in bipartite matching /
 * set-cover if it ever matters:
 *  - process instances closest to done first (smallest shortfall), so scarce
 *    easy people aren't burned on the largest gaps;
 *  - within an instance prefer cheaper tiers, then higher-coverage people (those
 *    whose one move closes the most same-cert instances).
 *
 * One move per person applies to renewals too: someone committed to renewing
 * Cert A won't also be nominated to earn Cert B. That's right for "they can only
 * sit one exam", and mildly pessimistic for anyone who could do both.
 *
 * `netNewByInstance` is the remainder **per instance** and so is deliberately NOT
 * deduped — summing it charges a shared cert once per requirement. Totals go
 * through `netNewTotal`, which applies the same same-cert dedup to the remainder.
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
  // Guard so each person is credited to a given instance at most once. Without
  // it, a cert shared by two instances (e.g. required by two specialisations)
  // re-credits an already-committed person every time the outer loop reaches
  // another same-cert instance — inflating `filled` and duplicating `closes`.
  const credited = new Set<string>(); // `${email}::${instanceId}`

  const record = (email: string, inst: ReqInstance, member: PoolMember) => {
    if (!closesByEmail.has(email)) closesByEmail.set(email, []);
    closesByEmail.get(email)!.push({
      program: inst.program,
      specialisation: inst.specialisation,
      tierName: inst.tierName,
      cert: inst.cert,
      scopeLabel: inst.scopeLabel,
      tier: member.tier,
      path: member.path,
    });
  };

  // Process instances closest to done first (smallest shortfall), so scarce
  // easy candidates aren't burned on the largest gaps.
  const ordered = [...open].sort((a, b) => a.shortfall - b.shortfall);

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

      // Credit this move to every open same-cert instance that can use them,
      // but never twice to the same instance (a later same-cert pass would
      // otherwise re-credit an already-committed person).
      for (const other of byCertKey.get(inst.certKey)!) {
        if ((filled.get(other.id) ?? 0) >= other.shortfall) continue;
        const ck = `${cand.email}::${other.id}`;
        if (credited.has(ck)) continue;
        const m = other.pool.find((p) => p.email === cand.email);
        if (!m) continue;
        credited.add(ck);
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

/**
 * The key two instances must share for one person's certification to count for
 * both: the same qualifying cert-set over the same population.
 *
 * `resolveGeoPlan` yields a single population per plan today, so `scopeLabel` is
 * currently constant — it is in the key anyway because the alternative fails
 * silently and expensively (collapsing two countries' gaps into one) if a future
 * change reintroduces multiple populations.
 */
function certGroupKey(inst: ReqInstance): string {
  return `${inst.certKey}::${inst.scopeLabel}`;
}

/**
 * People still needing brand-new training across `instances`, counting a
 * certification required by several of them over the same population ONCE.
 *
 * This is the net-new half of the dedup `allocateCandidates` already performs for
 * named people. Per group we take the **largest** remaining gap, not the sum:
 * instances in a group share a population and therefore share candidate pools, so
 * one cohort of N new holders satisfies every instance in the group whose gap is
 * ≤ N. Three specialisations each needing 2 holders of the same cert cost 2
 * people, not 6.
 *
 * Pure, like `allocateCandidates` — `alloc` supplies the post-allocation
 * remainder per instance and nothing here touches the database.
 */
export function netNewTotal(instances: ReqInstance[], alloc: AllocationResult): number {
  const byGroup = new Map<string, number>();
  for (const inst of instances) {
    const key = certGroupKey(inst);
    const remaining = alloc.netNewByInstance.get(inst.id) ?? 0;
    byGroup.set(key, Math.max(byGroup.get(key) ?? 0, remaining));
  }
  let total = 0;
  for (const n of byGroup.values()) total += n;
  return total;
}

/**
 * People-moves to close a SET of specialisations, counting a certification
 * required by several of them over the same population once.
 *
 * Same max-per-group rule as `netNewTotal`, and for the same reason: instances
 * sharing a `certGroupKey` share a population, so one cohort of N new holders
 * satisfies every instance in the group whose gap is ≤ N. Where this differs is
 * what it costs — the raw planning gap (`inst.shortfall`), because it ranks
 * specialisations *before* allocation has happened and so has no post-allocation
 * remainder to read.
 *
 * Pure and exported for the same reason `allocateCandidates` is: the tier
 * cheapest-path ranking it drives is the part worth exercising directly.
 */
export function specSetCost(names: Iterable<string>, bySpec: Map<string, ReqInstance[]>): number {
  const byGroup = new Map<string, number>();
  for (const name of names) {
    for (const inst of bySpec.get(name) ?? []) {
      const key = certGroupKey(inst);
      byGroup.set(key, Math.max(byGroup.get(key) ?? 0, inst.shortfall));
    }
  }
  let total = 0;
  for (const n of byGroup.values()) total += n;
  return total;
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
  // "Plan for the window" is meaningless without a window.
  const planForWindow = horizon !== null && input.planForWindow;

  const idx = await buildCatalogueIndex();
  const geo = await resolveGeoPlan(input);

  const targets: PlanTargetResult[] = [];

  // Per-target preparation captured before allocation: how its instances group
  // into specialisations, and — for a tier target — which specialisations the
  // plan is *costed against* (the cheapest `needed`, chosen by marginal cost) vs
  // which merely swap in for one of them at no extra cost.
  interface TargetPrep {
    target: PlanTargetResult;
    bySpec: Map<string, ReqInstance[]>;
    tierDeployInsts: ReqInstance[];
    /** The instances that count toward this target's people-to-certify total. */
    counted: ReqInstance[];
    /** instanceId → the OTHER specialisations needing the same cert (see `sharedWith`). */
    sharedByInstanceId: Map<string, string[]>;
    /** The cheapest `needed` specialisations, in the order they were picked;
     *  empty for non-tier targets. These are what `counted` was built from. */
    chosenSpecs: string[];
    /** Specialisations that swap in for a chosen one at no extra cost. */
    alternativeSpecs: Set<string>;
    /** Marginal cost per chosen/alternative specialisation (see `marginalCost`). */
    marginalBySpec: Map<string, number>;
  }
  const preps: TargetPrep[] = [];
  // Only counted instances feed the allocator + totals, so a tier target costs
  // just its cheapest path, not every specialisation in the program.
  const countedInstances: ReqInstance[] = [];

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

    // Build instances for every active row (one scoped instance per in-scope row).
    const rowInstances: ReqInstance[] = [];
    for (const row of activeRows) {
      const built = await buildInstances(target.program, row, geo, idx, now, horizon, planForWindow);
      // Tag tier-deployment instances with the tier name for display.
      if (chosenTier && row.tierId === chosenTier.id) {
        for (const b of built) b.tierName = chosenTier.name;
      }
      rowInstances.push(...built);
    }

    // Group instances into specialisation blocks + the tier's delivery certs.
    const bySpec = new Map<string, ReqInstance[]>();
    const tierDeployInsts: ReqInstance[] = [];
    for (const inst of rowInstances) {
      if (inst.tierName && !inst.specialisation) {
        tierDeployInsts.push(inst);
        continue;
      }
      const key = inst.specialisation ?? "—";
      if (!bySpec.has(key)) bySpec.set(key, []);
      bySpec.get(key)!.push(inst);
    }

    // Which of this target's requirements are the *same* cert over the same
    // population, so the page can say why the per-specialisation figures add up
    // to more than the headline. Computed over every instance, counted or not —
    // it is informational, and a non-counted specialisation's requirement is just
    // as shared. `label` mirrors how the roadmap groups the rows.
    const specLabel = (inst: ReqInstance) => inst.specialisation ?? inst.tierName ?? "—";
    const labelsByGroup = new Map<string, Set<string>>();
    for (const inst of rowInstances) {
      const key = certGroupKey(inst);
      if (!labelsByGroup.has(key)) labelsByGroup.set(key, new Set());
      labelsByGroup.get(key)!.add(specLabel(inst));
    }
    const sharedByInstanceId = new Map<string, string[]>();
    for (const inst of rowInstances) {
      const others = [...(labelsByGroup.get(certGroupKey(inst)) ?? [])]
        .filter((n) => n !== specLabel(inst))
        .sort((a, b) => a.localeCompare(b));
      sharedByInstanceId.set(inst.id, others);
    }

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

    // Decide which instances count toward reaching the target.
    const countedIds = new Set<string>();
    const chosenSpecs: string[] = [];
    const alternativeSpecs = new Set<string>();
    const marginalBySpec = new Map<string, number>();
    if (chosenTier && targetResult.tierPlan) {
      // Achieved-ness reads the *planning* gap, so when planning for the renewal
      // window a specialisation that lapses inside it stops counting toward the
      // tier — `needed` rises and the cheapest path can legitimately change.
      const specAchieved = new Map<string, boolean>();
      for (const [name, insts] of bySpec) {
        specAchieved.set(name, insts.every((i) => i.shortfall === 0));
      }
      const achievedCount = [...specAchieved.values()].filter(Boolean).length;
      const needed = Math.max(0, chosenTier.specialisationsRequired - achievedCount);
      targetResult.tierPlan.alreadyAchieved = achievedCount;
      targetResult.tierPlan.needed = needed;
      targetResult.tierPlan.deliveryCertShortfall = tierDeployInsts.reduce((s, i) => s + i.shortfall, 0);

      // Reaching the tier needs only `needed` more specialisations, so pick that
      // many — greedily, by **marginal** cost (v2). A standalone per-specialisation
      // cost charges two specialisations sharing a certification in full each, so
      // the two cheapest-looking were routinely not the cheapest pair: one that
      // reads "4 to certify" but shares half its requirements with a specialisation
      // already picked really adds 2. `specSetCost` costs the set honestly, and
      // asking it what each candidate *adds* to the set so far is what makes the
      // per-specialisation figures sum to the target's headline.
      const remaining = [...bySpec.keys()]
        .filter((n) => !specAchieved.get(n))
        .sort((a, b) => a.localeCompare(b));
      if (needed > 0 && remaining.length > 0) {
        const k = Math.min(needed, remaining.length);
        const pool = new Set(remaining);
        for (let i = 0; i < k; i++) {
          const base = specSetCost(chosenSpecs, bySpec);
          let best: string | null = null;
          let bestMarginal = Infinity;
          for (const name of pool) {
            const marginal = specSetCost([...chosenSpecs, name], bySpec) - base;
            // localeCompare on a genuine tie, so the pick is deterministic rather
            // than dependent on Map insertion order.
            if (marginal < bestMarginal || (marginal === bestMarginal && best !== null && name.localeCompare(best) < 0)) {
              best = name;
              bestMarginal = marginal;
            }
          }
          if (best === null) break;
          pool.delete(best);
          chosenSpecs.push(best);
          marginalBySpec.set(best, bestMarginal);
        }

        // An alternative is a specialisation that can be swapped in for one of the
        // chosen ones without the set costing more — the honest version of the old
        // "equal standalone cost" test, which called two specialisations equal when
        // only one of them shared its certifications with the rest of the plan.
        // k × (n−k) set-cost evaluations over the handful of specialisations a
        // program has: not worth indexing, and deliberately left plain so it stays
        // readable rather than becoming something subtler that nobody trusts.
        const baseline = specSetCost(chosenSpecs, bySpec);
        for (const name of remaining) {
          if (marginalBySpec.has(name)) continue;
          const swaps = chosenSpecs.some(
            (c) => specSetCost([...chosenSpecs.filter((x) => x !== c), name], bySpec) <= baseline,
          );
          if (!swaps) continue;
          alternativeSpecs.add(name);
          marginalBySpec.set(name, specSetCost([...chosenSpecs, name], bySpec) - baseline);
        }

        for (const name of chosenSpecs) {
          for (const inst of bySpec.get(name)!) countedIds.add(inst.id);
        }
      }
      // Tier delivery certs always count toward the tier.
      for (const inst of tierDeployInsts) countedIds.add(inst.id);
    } else {
      // Non-tier targets: every instance counts.
      for (const inst of rowInstances) countedIds.add(inst.id);
    }

    const counted = rowInstances.filter((inst) => countedIds.has(inst.id));
    countedInstances.push(...counted);
    preps.push({
      target: targetResult,
      bySpec,
      tierDeployInsts,
      counted,
      sharedByInstanceId,
      chosenSpecs,
      alternativeSpecs,
      marginalBySpec,
    });
  }

  // Greedy allocation across only the COUNTED instances of ALL targets at once
  // (contention is global — a person spent in Program A can't also be spent in
  // Program B). Non-counted instances (a tier's unchosen specialisations)
  // are shown for reference but don't inflate the plan's totals.
  const alloc = allocateCandidates(countedInstances);

  // Student display info for every committed candidate + every renewal-at-risk
  // holder + every eligible pool member (so the full-pool list can be named).
  const candidateEmails = new Set<string>(alloc.closesByEmail.keys());
  for (const inst of countedInstances) {
    for (const e of inst.expiringEmails) candidateEmails.add(e);
    for (const m of inst.pool) candidateEmails.add(m.email);
  }
  const students = candidateEmails.size > 0
    ? await prisma.student.findMany({
        where: { email: { in: [...candidateEmails] } },
        select: { email: true, fullName: true, country: true, theatre: true },
      })
    : [];
  const studentById = new Map(students.map((s) => [s.email, s]));

  // ── Roll instances back up into the per-target roadmap ──
  for (const {
    target, bySpec, tierDeployInsts, counted, sharedByInstanceId,
    chosenSpecs, alternativeSpecs, marginalBySpec,
  } of preps) {
    const chosenSet = new Set(chosenSpecs);
    const shared = (inst: ReqInstance) => sharedByInstanceId.get(inst.id) ?? [];
    const specs: PlanSpecialisation[] = [];
    for (const [name, specInsts] of bySpec) {
      const requirements = specInsts.map((inst) => toPlanRequirement(inst, alloc, shared(inst)));
      // Cost is the *planning* gap, so read the instance — the DTO's `shortfall`
      // is deliberately today's figure.
      const cost = specInsts.reduce((s, i) => s + i.shortfall, 0);
      const easyWins = specInsts.reduce(
        (s, inst) => s + inst.pool.filter((p) => p.tier === "easy-win").length,
        0,
      );
      const spec: PlanSpecialisation = {
        name,
        // Derived from the attained counts, not `shortfall`, so both flags mean
        // the same thing whether or not we're planning for the window.
        achieved: isAchievedNow(requirements),
        projectedAchieved: isAchievedAtHorizon(requirements),
        cost,
        easyWins,
        requirements,
      };
      if (target.tierPlan) {
        spec.chosen = chosenSet.has(name);
        // Only set on the two flagged kinds: a specialisation nobody is being asked
        // to consider has no "on top of the chosen ones" figure to report.
        if (alternativeSpecs.has(name)) spec.alternative = true;
        const marginal = marginalBySpec.get(name);
        if (marginal !== undefined) spec.marginalCost = marginal;
      }
      specs.push(spec);
    }
    specs.sort((a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name));

    // Surface tier deployment requirements as a synthetic specialisation block.
    if (target.tierPlan && tierDeployInsts.length > 0) {
      const deployReqs = tierDeployInsts.map((inst) => toPlanRequirement(inst, alloc, shared(inst)));
      specs.push({
        name: `${target.tierName} — delivery certs`,
        achieved: isAchievedNow(deployReqs),
        projectedAchieved: isAchievedAtHorizon(deployReqs),
        cost: tierDeployInsts.reduce((s, i) => s + i.shortfall, 0),
        easyWins: tierDeployInsts.reduce((s, i) => s + i.pool.filter((p) => p.tier === "easy-win").length, 0),
        requirements: deployReqs,
        chosen: true,
      });
    }

    target.specialisations = specs;

    // Per-target totals: distinct committed people whose close touches this
    // target, plus its counted net-new slots.
    const targetEmails = new Set<string>();
    let easyWins = 0;
    for (const [email, closes] of alloc.closesByEmail) {
      if (closes.some((c) => c.program === target.program)) {
        targetEmails.add(email);
        if (alloc.committedTier.get(email) === "easy-win") easyWins++;
      }
    }
    // Deduped, so a cert several of this target's specialisations require is paid
    // for once — matching how `targetEmails` already counts a shared person once.
    const netNew = netNewTotal(counted, alloc);
    target.easyWins = easyWins;
    target.netNew = netNew;
    target.peopleMoves = targetEmails.size + netNew;
    target.headline = buildHeadline(target, geo.scopeLabel, input.renewalWindowMonths);
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

  // ── Full eligible pool (superset of the nominated candidates) ──
  // Everyone in any counted requirement's pool, deduped by person, with every
  // gap they could contribute to. Unlike `candidates`, this ignores allocation
  // and contention — it's the "who else could we certify" list.
  const eligibleByEmail = new Map<string, PlanCandidateClose[]>();
  for (const inst of countedInstances) {
    for (const m of inst.pool) {
      if (!eligibleByEmail.has(m.email)) eligibleByEmail.set(m.email, []);
      eligibleByEmail.get(m.email)!.push({
        program: inst.program,
        specialisation: inst.specialisation,
        tierName: inst.tierName,
        cert: inst.cert,
        scopeLabel: inst.scopeLabel,
        tier: m.tier,
        path: m.path,
      });
    }
  }
  const eligible: PlanCandidate[] = [];
  for (const [email, closes] of eligibleByEmail) {
    const s = studentById.get(email);
    const sortedCloses = [...closes].sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier));
    eligible.push({
      email,
      fullName: s?.fullName ?? email,
      country: s?.country ?? "",
      theatre: s?.theatre ?? "",
      topTier: sortedCloses[0]?.tier ?? "easy-win",
      closesCount: closes.length,
      closes: sortedCloses,
    });
  }
  eligible.sort(
    (a, b) => tierOrder(a.topTier) - tierOrder(b.topTier) || b.closesCount - a.closesCount || a.fullName.localeCompare(b.fullName),
  );

  // ── What the renewals actually break ──
  // Built here, not on the client, from `countedInstances` — the set the plan was
  // actually costed against. `spec.chosen` used to be a wider tie-set, so deriving
  // this client-side would have named requirements whose expiring holders never
  // appear in the table below it; now that `chosen` is exactly the cheapest-K, a
  // client derive would agree. It stays here anyway because `countedInstances` is
  // the definition and the flag only reflects it — a future counted instance that
  // isn't a chosen specialisation's would silently vanish from a client derive.
  const riskImpacts: PlanRiskImpact[] = countedInstances
    .filter((i) => i.shortfallProjected !== null && i.shortfallProjected > 0 && i.expiringEmails.length > 0)
    .map((i) => ({
      program: i.program,
      specialisation: i.specialisation,
      tierName: i.tierName,
      cert: i.cert,
      scopeLabel: i.scopeLabel,
      required: i.required,
      attained: i.attained,
      projectedAttained: i.projectedAttained ?? i.attained,
    }))
    // Requirements that are fine today lead — those are the surprising ones.
    .sort(
      (a, b) =>
        Number(b.attained >= b.required) - Number(a.attained >= a.required) ||
        (b.required - b.projectedAttained) - (a.required - a.projectedAttained) ||
        a.cert.localeCompare(b.cert),
    );

  // ── Renewal-at-risk rows (deduped by email+cert+scope) ──
  const renewals: PlanRenewalRow[] = [];
  const renewalSeen = new Set<string>();
  const renewalEmails = new Set<string>();
  for (const inst of countedInstances) {
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
  let renewalMoves = 0;
  // Explicit four-way branch: a catch-all `else` would silently bank every
  // renewal commitment as legacy.
  for (const tier of alloc.committedTier.values()) {
    if (tier === "renewal") renewalMoves++;
    else if (tier === "easy-win") easyWins++;
    else if (tier === "lapsed") lapsed++;
    else if (tier === "legacy") legacy++;
  }
  // Deduped across every counted instance of every target at once, so a cert
  // required by two selected programs is one cohort — the same scope the greedy
  // allocator treats contention over.
  const netNew = netNewTotal(countedInstances, alloc);

  return {
    scopeLabel: geo.scopeLabel,
    renewalWindowMonths: input.renewalWindowMonths,
    planForWindow,
    targets,
    candidates,
    eligible,
    renewals,
    riskImpacts,
    totals: {
      peopleMoves: alloc.closesByEmail.size + netNew,
      easyWins,
      lapsed,
      legacy,
      netNew,
      renewalMoves,
      renewalsAtRisk: renewalEmails.size,
    },
  };
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function tierOrder(t: CandidateTier): number {
  return t === "renewal" ? -1 : t === "easy-win" ? 0 : t === "lapsed" ? 1 : t === "legacy" ? 2 : 3;
}

/** Met today — the plain requirement check, independent of the planning basis. */
function isAchievedNow(reqs: PlanRequirement[]): boolean {
  return reqs.every((r) => r.attained >= r.required);
}

/** Still met at the end of the renewal window; null when no window is selected. */
function isAchievedAtHorizon(reqs: PlanRequirement[]): boolean | null {
  if (reqs.some((r) => r.projectedAttained === null)) return null;
  return reqs.every((r) => (r.projectedAttained ?? r.attained) >= r.required);
}

function toPlanRequirement(
  inst: ReqInstance,
  alloc: AllocationResult,
  sharedWith: string[],
): PlanRequirement {
  return {
    instanceId: inst.id,
    specialisation: inst.specialisation,
    tierName: inst.tierName,
    purpose: inst.purpose,
    nativeLevel: inst.nativeLevel,
    scopeLabel: inst.scopeLabel,
    cert: inst.cert,
    required: inst.required,
    attained: inst.attained,
    projectedAttained: inst.projectedAttained,
    shortfall: inst.shortfallNow,
    projectedShortfall: inst.shortfallProjected,
    renewalPool: inst.pool.filter((p) => p.tier === "renewal").length,
    easyWinPool: inst.pool.filter((p) => p.tier === "easy-win").length,
    lapsedPool: inst.pool.filter((p) => p.tier === "lapsed").length,
    legacyPool: inst.pool.filter((p) => p.tier === "legacy").length,
    // Counted instances get their allocated net-new; non-counted (a tier's
    // unchosen specialisations) fall back to their raw shortfall.
    netNew: alloc.netNewByInstance.get(inst.id) ?? inst.shortfall,
    sharedWith,
    expiringSoon: inst.expiringEmails.length,
  };
}

function buildHeadline(target: PlanTargetResult, scopeLabel: string, windowMonths: number): string {
  const where = scopeLabel === "Global" ? "globally" : `in ${scopeLabel}`;
  if (target.peopleMoves === 0) {
    // Don't claim "nobody left to certify" when the window says otherwise: a
    // specialisation met today can still fall below target as training expires.
    const atRisk = target.specialisations.filter((s) => s.achieved && s.projectedAchieved === false);
    if (atRisk.length > 0) {
      const n = atRisk.length;
      return (
        `${target.program} is compliant ${where} today, but ${n} specialisation${n === 1 ? "" : "s"} ` +
        `fall${n === 1 ? "s" : ""} below target within ${windowMonths} month${windowMonths === 1 ? "" : "s"} ` +
        `as training expires — renew to hold it.`
      );
    }
    return `${target.program} is fully compliant ${where} — nobody left to certify.`;
  }
  const noun = target.peopleMoves === 1 ? "person" : "people";
  const easy = target.easyWins > 0 ? `, ${target.easyWins} of them easy wins` : "";
  if (target.tierPlan && target.tierName) {
    const { needed, deliveryCertShortfall } = target.tierPlan;
    const parts: string[] = [];
    if (needed > 0) {
      // `chosen` is exactly `needed` long, and each figure is the specialisation's
      // *marginal* cost — so the listed parts add up to the headline's total
      // instead of overstating it by charging a shared certification twice.
      const rec = target.specialisations.filter((s) => s.chosen && !s.name.endsWith("delivery certs"));
      const names = rec.map(
        (s) => `${s.name} (${s.marginalCost ?? s.cost} to certify${s.easyWins > 0 ? `, ${s.easyWins} easy` : ""})`,
      );
      let clause = `achieve ${needed} more specialisation${needed === 1 ? "" : "s"}`;
      if (names.length > 0) {
        const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
        clause += ` — cheapest ${names.length === 1 ? "is" : "are"} ${joined}`;
      }
      // A cost-neutral swap is worth naming: the pick between two equal paths is
      // arbitrary, and the other one may suit the business better.
      const alts = target.specialisations
        .filter((s) => s.alternative && !s.name.endsWith("delivery certs"))
        .map((s) => s.name);
      if (alts.length > 0) clause += ` — or swap in ${alts.join(" or ")} at the same cost`;
      parts.push(clause);
    }
    if (deliveryCertShortfall > 0) {
      parts.push(`${deliveryCertShortfall} more delivery-cert ${deliveryCertShortfall === 1 ? "person" : "people"}`);
    }
    const body = parts.length > 0 ? parts.join(", plus ") : "close the remaining gaps";
    return `To reach ${target.tierName} ${where}: ${body}. ~${target.peopleMoves} ${noun} to certify${easy}.`;
  }
  return `${target.program} ${where}: ~${target.peopleMoves} ${noun} to certify to close all gaps${easy}.`;
}
