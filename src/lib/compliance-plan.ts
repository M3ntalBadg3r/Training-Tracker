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
 * summing (`groupCost`, which also knows that an "each country" requirement's
 * per-country gaps add up across countries while still counting toward a pooled
 * requirement on the same cert). Only the totals dedup — `PlanRequirement.netNew` and
 * `PlanSpecialisation.cost` stay per-instance/standalone, because each of those
 * figures is true of that requirement read on its own, and `sharedWith` names the
 * other specialisations so the page can say the total counts it once. The same
 * dedup decides a tiered target's cheapest-K specialisations: `specSetCost` costs
 * a *set* rather than each member, and the ranking picks greedily by what each
 * candidate adds to the set so far, so two specialisations sharing a cert rank as
 * the bargain they are. Greedy, not exact — picking the genuinely cheapest set is
 * set cover — but the approximation is now in the search, not in the cost.
 *
 * **Count modes.** A requirement authored at the Region or CountrySet level is
 * either pooled ("total": one instance over the whole area, like every other
 * level) or "each country": every country in the area must reach the quantity on
 * its own, so it becomes one instance per country (`buildEachCountryInstances`,
 * one bucketed query per row). Everything downstream — pools, the allocator,
 * specialisation achievement, the tier ladder — then works per instance without
 * knowing which mode produced it.
 */

import prisma from "@/lib/prisma";
import { ELIGIBLE_TRAINING_DATA } from "@/lib/reportable-training";
import { addMonths } from "@/lib/utils";
import {
  getEmailSetsByTitle,
  getEmailSetsByTitleAndGeo,
  resolveSiblingTitles,
  countriesInRegion,
  type ComplianceScope,
} from "@/lib/program-compliance";
import { COUNTRY_SET_SCOPE_ERROR, countriesInCountrySet, singleCompanyId } from "@/lib/country-sets";
import {
  resolveCountrySetMinimum,
  resolveTargetArea,
  TARGET_COUNTRIES_SCOPE_ERROR,
  type ProgramTermsRow,
} from "@/lib/program-target-countries";
import {
  isProgramWideRow,
  normaliseAggregation,
  type Aggregation,
  type CountrySetMinimumMeta,
  type MinimumCountriesSource,
  type MinimumView,
  type PopulationKind,
  type ReqLevel,
  type ScopeLevel,
  type TargetCountriesMeta,
  isTheatreIncluded,
} from "@/lib/program-levels";

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
  /**
   * The selected plan scope. Each scope plans against its own levels' rows
   * only (`SCOPE_REQ_LEVELS`). Every scope reads one level except `"theatre"`,
   * which — for a program with TargetCountries rows — also counts those rows
   * over the partner's target countries inside the theatre (see
   * `resolveTheatreTargetPlanArea`).
   */
  level: ScopeLevel;
  country: string;
  region: string;
  /**
   * A Country Set name. At `level` "countrySet" it is the set planned over;
   * blank means each program's partner Country Set-view set
   * (`ProgramCompanySetting.countrySetId`). At `level` "theatre" it names the
   * target set for programs with TargetCountries rows; blank means each
   * program's partner Theatre-view set (`ProgramCompanySetting.targetCountrySetId`).
   */
  countrySet: string;
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
  /**
   * `${program}::${programDataId}` — the authored requirement this instance came
   * from. An "each country" requirement yields one instance per country, all
   * sharing this key, which is what lets the page group them back under one row.
   */
  requirementKey: string;
  specialisation: string | null;
  tierName: string | null;
  purpose: string;
  /** Country | Region | CountrySet | Theatre | Global — the requirement's authored (native) level. */
  nativeLevel: ReqLevel;
  /** "total" (pooled across the scope) or "eachCountry" (one instance per country). */
  aggregation: Aggregation;
  /**
   * The country this instance is counted over, for an "each country"
   * requirement; null for a pooled (scope-wide) one — including the single
   * placeholder an "each country" requirement yields when the scope has no
   * countries at all.
   */
  country: string | null;
  /** The population label this instance is counted over, e.g. "UK" / "Global". */
  scopeLabel: string;
  /**
   * Theatre plans of a program with TargetCountries rows only (absent
   * otherwise, so every other plan's payload is unchanged): which of the
   * program's two populations this row is counted over — `"theatre"` (the
   * viewed theatre) or `"targetCountries"` (the partner's target countries in
   * it, or one of them for an "each country" row).
   */
  population?: PopulationKind;
  cert: string;
  /**
   * The qualifying certifications' full titles, primary first, de-duplicated —
   * the list `cert` joins with " or ". Carried as a list because a full title
   * may itself contain " or ", so the page cannot split `cert` back apart.
   * Display only.
   */
  certTitles: string[];
  /** The requirement's optional display name (ProgramData.label); null when unnamed. Display only — `cert` stays the identity. */
  label: string | null;
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
   * The other specialisations in this target that need the same cert over a
   * shared population — the same population, or this one's country inside the
   * other's area (or vice versa). Non-empty means this requirement's
   * `netNew`/gap is shared: closing it closes theirs too, and the target's
   * totals charge for it once.
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
  /** People-moves to close this specialisation (sum of its instances' shortfall —
   *  an "each country" requirement contributes every country's gap). */
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
   *  ones* (and of the program-wide requirements, which every tier pays for) —
   *  equal to `cost` unless it shares a certification with them, in which case
   *  the shared cert is already paid for. Set for chosen and alternative
   *  specialisations only. */
  marginalCost?: number;
  /**
   * `"programWide"` marks the synthetic block holding a tiered program's
   * program-wide requirements (rows with neither a specialisation nor a tier):
   * required at every tier, always counted, never ranked. Absent on every real
   * specialisation and on the tier's "delivery certs" block.
   */
  kind?: "programWide";
}

/** The synthetic block name for a tiered program's program-wide requirements. */
export const PROGRAM_WIDE_BLOCK_NAME = "Required at every level";

/**
 * Something that blocks a target and that certifying people cannot fix. Never
 * costed into "People to certify" — it is reported beside the plan instead.
 *
 * `minimumCountries`: fewer countries than the program's minimum for the
 * view, so no tier can be reached until more are added to a Country Set.
 *  - `view: "theatre"` — a program with TargetCountries rows, planned at a
 *    theatre: the partner names fewer target countries inside that theatre
 *    (`areaName`) than its Theatre-view minimum.
 *  - `view: "countrySet"` — planned at a Country Set: the set (`areaName`, or
 *    null when the partner has none configured) holds fewer countries than the
 *    program's Country Set-view minimum.
 * `required` is the minimum, `counted` the countries that count toward it, and
 * `source` whose rule the minimum is (`partner` setting or program `default`).
 */
export interface PlanBlocker {
  kind: "minimumCountries";
  view: MinimumView;
  /** The theatre (theatre view) or the Country Set (country set view); null = no set configured. */
  areaName: string | null;
  required: number;
  counted: number;
  source: MinimumCountriesSource;
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
    /**
     * People needed for the program-wide requirements (deduped like the
     * totals). Present only when the program has such rows in scope, so a
     * program without them keeps its payload unchanged.
     */
    gateShortfall?: number;
  };
  specialisations: PlanSpecialisation[];
  peopleMoves: number;
  easyWins: number;
  netNew: number;
  /**
   * Theatre plans of a program with TargetCountries rows only: the target
   * countries this target was planned over (the theatre, the target Country
   * Set and its in-theatre countries, the members left out because they lie
   * outside the theatre) and the partner's Theatre-view minimum. Aggregates
   * and geography names — no person identifier.
   */
  targetCountries?: TargetCountriesMeta;
  /**
   * Country Set plans only: the set this target was planned over (the one
   * requested, or the partner's configured Country Set-view set when none
   * was), its members and the program's Country Set-view minimum.
   */
  countrySetMinimum?: CountrySetMinimumMeta;
  /** Only when non-empty. See `PlanBlocker`. */
  blockers?: PlanBlocker[];
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
  /**
   * Every such title the person holds at this tier, `path` first. A person
   * holding two trainings that lead to the cert used to be credited with
   * whichever the pool met first, so "Relevant training held" named one.
   */
  paths: string[];
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
  /** See `PlanRequirement.certTitles`. */
  certTitles: string[];
  /** See `PlanRequirement.label`. */
  label: string | null;
  /** See `PlanRequirement.aggregation`. */
  aggregation: Aggregation;
  /** See `PlanRequirement.country` — set for one country of an "each country" requirement. */
  country: string | null;
  scopeLabel: string;
  /** See `PlanRequirement.population` — theatre plans of a targets program only. */
  population?: PopulationKind;
  required: number;
  attained: number;
  projectedAttained: number;
  /**
   * On the plan's recommended path — a counted instance: a tier target's chosen
   * specialisations plus its delivery certs, or any instance of a non-tier
   * target. False means the roadmap dims this requirement for reference and
   * nothing here is costed into "People to certify". Named `onPath` rather than
   * `chosen` because `PlanSpecialisation.chosen` is narrower — it is unset for
   * non-tier targets, where every row is nonetheless on the path — and reusing
   * the word would invite a client-side derive that gets delivery certs wrong.
   */
  onPath: boolean;
}

export interface PlanRenewalRow {
  email: string;
  fullName: string;
  country: string;
  theatre: string;
  cert: string;
  /** See `PlanRequirement.certTitles`. */
  certTitles: string[];
  /** The requirement's optional display name (ProgramData.label); null when unnamed. */
  label: string | null;
  /**
   * The certification this person actually holds that lapses inside the window
   * (its full title), and when it does (ISO date). When they hold several
   * qualifying ones, the latest-expiring — that is when they stop counting.
   * Null only if the completion could not be found again (it has just been
   * changed under the plan).
   */
  heldTraining: string | null;
  expiresOn: string | null;
  scopeLabel: string;
  /**
   * On the plan's recommended path — a counted instance: a tier target's chosen
   * specialisations plus its delivery certs, or any instance of a non-tier
   * target. False means the roadmap dims this requirement for reference and
   * nothing here is costed into "People to certify". Named `onPath` rather than
   * `chosen` because `PlanSpecialisation.chosen` is narrower — it is unset for
   * non-tier targets, where every row is nonetheless on the path — and reusing
   * the word would invite a client-side derive that gets delivery certs wrong.
   */
  onPath: boolean;
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
  /**
   * Every holder whose qualifying training lapses inside the window, over every
   * requirement the roadmap shows — one row per (person, certification).
   * `onPath` marks the subset the plan is actually costed against. Deliberately
   * NOT scoped to the counted instances: that scoping made a 6-month window
   * report fewer renewals than a 3-month one, because the cheapest path is
   * costed from a window-dependent gap and shifts as the window widens.
   */
  renewals: PlanRenewalRow[];
  /**
   * The requirements those renewals break, over the same set and carrying the
   * same `onPath` marker, so the two always agree.
   */
  riskImpacts: PlanRiskImpact[];
  totals: {
    peopleMoves: number;
    easyWins: number;
    lapsed: number;
    legacy: number;
    netNew: number;
    /**
     * People the allocator actually committed to renew (0 unless planning for
     * the window). Costed from the counted instances only, so it is NOT the
     * number of at-risk renewals below and must not be widened to match them:
     * doing so would put uncosted people into `peopleMoves`. The ordering
     * `renewalMoves <= renewalsAtRiskOnPath <= renewalsAtRisk` always holds.
     */
    renewalMoves: number;
    /**
     * Rows in `renewals` — one per (person, certification) expiring inside the
     * window, on and off path. Equal to `renewals.length` by construction, so
     * the KPI card and the section heading cannot disagree. (This counted
     * distinct *people* until the overlay was widened; the heading could never
     * show that number, so the two reported different measures side by side.)
     */
    renewalsAtRisk: number;
    /** How many of those rows are on the recommended path. */
    renewalsAtRiskOnPath: number;
  };
}

// ─── Internal instance shape (fed to the pure allocator) ─────────────────────

interface PoolMember {
  email: string;
  tier: Exclude<CandidateTier, "net-new">;
  path: string | null;
  /** Every path held at `tier`, `path` first (see `PlanCandidateClose.paths`). */
  paths: string[];
}

/** A requirement instance with its resolved gap + candidate pools. */
interface ReqInstance {
  id: string;
  /** `${program}::${programDataId}` — shared by every per-country instance of one row. */
  requirementKey: string;
  program: string;
  specialisation: string | null;
  tierName: string | null;
  purpose: string;
  nativeLevel: ReqLevel;
  aggregation: Aggregation;
  /** Null = scope-wide (pooled); a name = one country of an "each country" row. */
  country: string | null;
  /**
   * The population this instance is counted over: `global`, `theatre:X`,
   * `country:X`, `region:X`, `countrySet:<companyId>:X` (a set is per-company)
   * or, for a program's target countries in a theatre,
   * `targetCountries:<companyId>:<theatre>:<set>`.
   * Used instead of `scopeLabel` in ids and group keys, because a country set
   * may be named like a country and the two must not collide. A per-country instance carries `country:X`.
   */
  populationKey: string;
  /**
   * The plan AREA this instance belongs to (`PlanArea.areaKey`), part of
   * `certGroupKey`. Every population inside one area is NESTED: a standard
   * scope has exactly one population (plus the per-country slices of it), and
   * a theatre area of a program with TargetCountries rows is the theatre ⊇ its
   * target countries ⊇ each single target country. `groupCost` and
   * `sharesPopulation` rely on that nesting — see `certGroupKey`. Two areas
   * whose populations are not nested in each other (two programs with
   * different target sets) carry different keys and are never deduped against
   * each other, which can over-count but never under-count.
   */
  areaKey: string;
  scopeLabel: string;
  /** Theatre plans of a targets program only — see `PlanRequirement.population`. */
  population?: PopulationKind;
  /** A tiered program's program-wide requirement (neither specialisation nor tier). */
  isGate: boolean;
  /** Optional display name (ProgramData.label). */
  label: string | null;
  /** Identity of the qualifying cert-set: two instances sharing it share moves. */
  certKey: string;
  cert: string;
  /** See `PlanRequirement.certTitles`. */
  certTitles: string[];
  /** The qualifying trainingTitles as authored (primary + alternatives), for the renewal lookup. */
  titles: string[];
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

/**
 * `holdersEver`, bucketed by the holder's country — the lapsed pool for an
 * "each country" requirement in ONE query over the whole area, rather than one
 * per country. A student has exactly one country, so each email lands in one
 * bucket.
 */
async function holdersEverByCountry(
  titles: string[],
  scope: ComplianceScope,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (titles.length === 0) return out;
  if (Array.isArray(scope.companyIds) && scope.companyIds.length === 0) return out;
  const { fetchTitles } = await resolveSiblingTitles(titles);
  const studentWhere = studentWhereFromScope(scope);
  const rows = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: fetchTitles },
      ...(studentWhere ? { student: studentWhere } : {}),
    },
    select: { email: true, student: { select: { country: true } } },
  });
  for (const r of rows) {
    const c = r.student.country;
    if (!out.has(c)) out.set(c, new Set());
    out.get(c)!.add(r.email);
  }
  return out;
}

/** A bucketed (title → country → emails) result, unioned across titles per country. */
function unionByCountry(byTitle: Map<string, Map<string, Set<string>>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const byCountry of byTitle.values()) {
    for (const [c, set] of byCountry) {
      if (!out.has(c)) out.set(c, new Set());
      const u = out.get(c)!;
      for (const e of set) u.add(e);
    }
  }
  return out;
}

/** Pivot title → country → emails into country → title → emails, keeping title order. */
function pivotByCountry(
  byTitle: Map<string, Map<string, Set<string>>>,
): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const [title, byCountry] of byTitle) {
    for (const [c, set] of byCountry) {
      if (!out.has(c)) out.set(c, new Map());
      out.get(c)!.set(title, set);
    }
  }
  return out;
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
 * A region plans against Region-level rows over the region's countries, and a
 * country set against CountrySet-level rows over the set's countries — the set
 * being the single scoped company's own (sets are per-company tenant data). (A region
 * used to pool the Country-level rows across its countries; that derivation is
 * gone — the dashboards dropped it too, and the two must agree.)
 */
interface GeoPlan {
  /** Which requirement `level` this population plans. */
  reqLevel: ReqLevel;
  /** The single population these requirements are counted over. */
  scope: ComplianceScope;
  scopeLabel: string;
  /**
   * `global` | `theatre:X` | `country:X` | `region:X` | `countrySet:<companyId>:X`.
   * A set's key carries its company because set names are unique only per company.
   */
  populationKey: string;
  /**
   * The countries an "each country" row splits over — the region's or the set's
   * members, sorted. Null for the single-population scopes, whose levels cannot
   * carry that count mode (`normaliseAggregation`).
   */
  countries: string[] | null;
  /** Theatre areas of a targets program only: which of the two populations this is. */
  population?: PopulationKind;
}

/**
 * Everything a target is planned over: one population per requirement level in
 * play, the key that scopes the cost dedup, and the per-view header (target
 * countries, or the Country Set's minimum) the page and the blocker read.
 *
 * Most scopes are ONE population (`resolveGeoPlan`), shared by every target.
 * Two cases are resolved PER PROGRAM instead, because the partner's terms are
 * per program: a theatre plan of a program with TargetCountries rows (each
 * program may name its own target set), and a Country Set plan with no set
 * named (each program's configured Country Set-view set).
 */
interface PlanArea {
  /** See `ReqInstance.areaKey`. */
  areaKey: string;
  scopeLabel: string;
  populations: GeoPlan[];
  targetCountries: TargetCountriesMeta | null;
}

function standardArea(geo: GeoPlan): PlanArea {
  return { areaKey: geo.populationKey, scopeLabel: geo.scopeLabel, populations: [geo], targetCountries: null };
}

/** Prefix of every theatre area that carries a target-countries population. */
const THEATRE_TARGETS_AREA_PREFIX = "theatreTargets:";

/**
 * The theatre area for one program with TargetCountries rows and one company:
 * Theatre rows over the viewed theatre, TargetCountries rows over the
 * partner's target countries (the target set's members inside the theatre,
 * resolved by `resolveTargetArea`, the one resolver the dashboard and the
 * public API use as well). The target set is the requested `countrySet`, or —
 * blank — the partner's configured Theatre-view set.
 *
 * When the scope is not exactly one company (the routes 400 that before ever
 * reaching here) the target population is EMPTY rather than the target being
 * dropped: its TargetCountries rows then fail closed — an "each country" row
 * as its unmet placeholder, a pooled row over nobody — instead of vanishing.
 *
 * The area key names BOTH populations. Inside it they are nested (the target
 * countries lie inside the theatre by construction — members outside it are
 * dropped into `outOfTheatreCountries`), which is exactly the property
 * `groupCost` needs to charge a pooled Theatre row and the target countries'
 * per-country gaps on one cert as `max(P, Σ g_c)`: everyone certified to close
 * a target country's gap is also inside the theatre. Keying on the theatre
 * alone would be wrong as soon as two programs (or two requests) used
 * different target sets over the same theatre: two DISJOINT target-wide
 * populations would share a group and be charged `max` instead of a sum.
 */
async function resolveTheatreTargetPlanArea(
  program: ProgramTermsRow,
  theatre: string,
  input: CompliancePlanInput,
): Promise<PlanArea> {
  const area = await resolveTargetArea({ program, theatre, countrySet: input.countrySet, companyIds: input.companyIds });
  const theatrePopulation: GeoPlan = {
    reqLevel: "Theatre",
    scope: "error" in area ? { theatre, companyIds: input.companyIds } : area.theatreScope,
    scopeLabel: theatre,
    populationKey: "error" in area ? `theatre:${theatre}` : area.theatrePopulationKey,
    countries: null,
    population: "theatre",
  };
  const targetLabel = `Target countries in ${theatre}`;
  if ("error" in area) {
    return {
      areaKey: `${THEATRE_TARGETS_AREA_PREFIX}theatre:${theatre}|targetCountries:none`,
      scopeLabel: theatre,
      populations: [
        theatrePopulation,
        {
          reqLevel: "TargetCountries",
          // `in: []` — nobody, never the world.
          scope: { countries: [], companyIds: input.companyIds },
          scopeLabel: targetLabel,
          populationKey: "targetCountries:none",
          countries: [],
          population: "targetCountries",
        },
      ],
      targetCountries: null,
    };
  }
  const { meta } = area;
  return {
    areaKey: `${THEATRE_TARGETS_AREA_PREFIX}${area.theatrePopulationKey}|${area.targetPopulationKey}`,
    scopeLabel: theatre,
    populations: [
      theatrePopulation,
      {
        reqLevel: "TargetCountries",
        scope: area.targetScope,
        scopeLabel: targetLabel,
        populationKey: area.targetPopulationKey,
        countries: meta.targetCountries,
        population: "targetCountries",
      },
    ],
    targetCountries: meta,
  };
}

/** The `populationKey` of a Country Set population — one definition for the
 *  shared and the per-program area, so a blank set that resolves to "Set 1"
 *  and an explicit "Set 1" are the same population and dedup together. */
function countrySetPopulationKey(companyId: number | null, countrySet: string): string {
  return `countrySet:${companyId ?? "none"}:${countrySet}`;
}

/**
 * The Country Set area for one program when the request names no set: the
 * partner's configured Country Set-view set (`resolveCountrySetMinimum`). With
 * no set configured the area has no countries, so the plan fails closed over
 * it. Also returns the minimum meta the blocker reads.
 */
function countrySetPlanArea(companyId: number, meta: CountrySetMinimumMeta, companyIds: number[] | null): PlanArea {
  const countries = [...meta.countries].sort((a, b) => a.localeCompare(b));
  return standardArea({
    reqLevel: "CountrySet",
    // `in: []` for an empty or unconfigured set — nobody, never the world.
    scope: { countries, companyIds },
    scopeLabel: meta.countrySet ?? "the partner's Country Set (none configured)",
    populationKey: countrySetPopulationKey(companyId, meta.countrySet ?? ""),
    countries,
  });
}

async function resolveGeoPlan(input: CompliancePlanInput): Promise<GeoPlan> {
  const { level, country, region, countrySet, theatre, companyIds } = input;

  if (level === "country" && country) {
    return {
      reqLevel: "Country",
      scope: { country, companyIds },
      scopeLabel: country,
      populationKey: `country:${country}`,
      countries: null,
    };
  }
  if (level === "region" && region) {
    const countries = [...(await countriesInRegion(region))].sort((a, b) => a.localeCompare(b));
    return {
      reqLevel: "Region",
      // An empty list is `in: []`, i.e. nobody — a region with no countries
      // configured has no population, not the whole world.
      scope: { countries, companyIds },
      scopeLabel: region,
      populationKey: `region:${region}`,
      countries,
    };
  }
  if (level === "countrySet") {
    // A Country Set is per-company tenant data: its name resolves only within
    // ONE company, and two companies may each own a same-named set over
    // different countries. The routes refuse a countrySet plan whose scope is
    // not exactly one company (400); should a caller skip that,
    // `countriesInCountrySet` answers `[]` for an ambiguous scope, so the plan
    // runs over an empty, never-met area rather than merging two companies'
    // sets. The company is in `populationKey` for the same reason the set name
    // is: "Set 1" of company 3 and "Set 1" of company 7 are different
    // populations and must never share a group or instance id.
    //
    // A BLANK set means each program's configured set, resolved per program in
    // the orchestrator; this shared area is then only the fail-closed fallback
    // (an empty area — never Global, which a blank value used to fall to).
    const companyId = singleCompanyId(companyIds);
    const countries = countrySet ? await countriesInCountrySet(countrySet, companyIds) : [];
    return {
      reqLevel: "CountrySet",
      scope: { countries, companyIds },
      scopeLabel: countrySet || "Country Set",
      populationKey: countrySetPopulationKey(companyId, countrySet),
      countries,
    };
  }
  if (level === "theatre" && theatre) {
    return {
      reqLevel: "Theatre",
      scope: { theatre, companyIds },
      scopeLabel: theatre,
      populationKey: `theatre:${theatre}`,
      countries: null,
    };
  }
  // Global (default): Global-level requirements over the whole population.
  return { reqLevel: "Global", scope: { companyIds }, scopeLabel: "Global", populationKey: "global", countries: null };
}

// ─── Program-data loading ────────────────────────────────────────────────────

interface RequirementRow {
  id: number;
  specialisationId: number | null;
  specialisationName: string | null;
  tierId: number | null;
  purpose: string;
  level: ReqLevel;
  /** Normalised: "eachCountry" only on a Region/CountrySet/TargetCountries row. */
  aggregation: Aggregation;
  quantityRequired: number;
  /** Qualifying cert trainingTitles: primary + alternatives. */
  titles: string[];
  /** Display: " or "-joined full titles. */
  cert: string;
  /** The same full titles as a list (see `PlanRequirement.certTitles`). */
  certTitles: string[];
  /** Optional display name (ProgramData.label). */
  label: string | null;
}

type ProgramDataWithRelations = {
  id: number;
  specialisationId: number | null;
  tierId: number | null;
  purpose: string;
  level: ReqLevel;
  aggregation: string;
  quantityRequired: number;
  trainingTitle: string | null;
  label: string | null;
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
    specialisationId: pd.specialisationId,
    specialisationName: pd.specialisation?.name ?? null,
    tierId: pd.tierId,
    purpose: pd.purpose,
    level: pd.level,
    // Re-normalised on read: the DB CHECK pins "eachCountry" to the two
    // multi-country levels, but a value that predates it must not split a
    // single-country requirement into per-country instances.
    aggregation: normaliseAggregation(pd.level, pd.aggregation),
    quantityRequired: pd.quantityRequired,
    titles,
    cert: [...new Set(fulls)].join(" or "),
    certTitles: [...new Set(fulls)],
    label: pd.label ?? null,
  };
}

// ─── Instance building (gap + pools) ─────────────────────────────────────────

/**
 * Identity of a row's qualifying cert-set, keyed on what is actually *counted*:
 * the (fullTitle, trainingType) groups `resolveSiblingTitles` expands to, not
 * the authored titles. A title with no catalogue row stays a singleton, which
 * is `resolveSiblingTitles`' own fallback.
 */
function certKeyFor(row: RequirementRow, idx: CatalogueIndex): string {
  return [...new Set(row.titles.map((t) => idx.pairKey.get(t) ?? t))].sort().join("|");
}

/** The trainings that are a path to any of a row's certs (ILT/OLX, or legacy). */
function pathTitles(
  row: RequirementRow,
  idx: CatalogueIndex,
  index: Map<string, { title: string; full: string }[]>,
): { titles: string[]; fullFor: Map<string, string> } {
  const titles: string[] = [];
  const fullFor = new Map<string, string>();
  for (const cert of row.titles) {
    for (const p of index.get(idx.pairKey.get(cert) ?? cert) ?? []) {
      titles.push(p.title);
      if (!fullFor.has(p.title)) fullFor.set(p.title, p.full);
    }
  }
  return { titles: [...new Set(titles)], fullFor };
}

/** The three gap figures for one population. */
function sizeGap(
  required: number,
  attained: number,
  projectedAttained: number | null,
  planForWindow: boolean,
): { shortfallNow: number; shortfallProjected: number | null; shortfall: number } {
  const shortfallNow = Math.max(0, required - attained);
  const shortfallProjected =
    projectedAttained === null ? null : Math.max(0, required - projectedAttained);
  // Planning *for* the window means closing the gap now AND still holding it at
  // the horizon — hence the max, not just the projected figure (a completion
  // landing inside the window must not discount a gap that is real today).
  // Every downstream consumer of `shortfall` (pools, the allocator, spec cost,
  // tier cheapest-path selection) then follows without further plumbing.
  const shortfall =
    planForWindow && shortfallProjected !== null
      ? Math.max(shortfallNow, shortfallProjected)
      : shortfallNow;
  return { shortfallNow, shortfallProjected, shortfall };
}

/**
 * One population's candidate pool, from holder sets already fetched. Shared by
 * the pooled and the per-country builders so the two cannot rank a candidate
 * differently. `addPool` keeps the cheapest tier per email, so the order below
 * only breaks ties between two paths of the same tier.
 */
function assemblePool(p: {
  active: Set<string>;
  expiringEmails: string[];
  planForWindow: boolean;
  ilt: Map<string, Set<string>> | undefined;
  iltFullFor: Map<string, string>;
  ever: Set<string> | undefined;
  legacy: Map<string, Set<string>> | undefined;
  legacyFullFor: Map<string, string>;
}): PoolMember[] {
  const seen = new Map<string, PoolMember>();
  // renewal: holders who lapse inside the window. They're excluded from every
  // other pool below (all skip `active`), so there's nothing to double-count.
  if (p.planForWindow) {
    for (const email of p.expiringEmails) addPool(seen, { email, tier: "renewal", path: null });
  }
  // easy-win: holders of an ILT/OLX that leads to any qualifying cert.
  for (const [title, set] of p.ilt ?? []) {
    const path = p.iltFullFor.get(title) ?? null;
    for (const email of set) {
      if (p.active.has(email)) continue;
      addPool(seen, { email, tier: "easy-win", path });
    }
  }
  // lapsed: ever-held minus currently-active.
  for (const email of p.ever ?? []) {
    if (p.active.has(email)) continue;
    addPool(seen, { email, tier: "lapsed", path: null });
  }
  // legacy: active holders of a legacy cert that upgrades into a qualifying cert.
  for (const [title, set] of p.legacy ?? []) {
    const path = p.legacyFullFor.get(title) ?? null;
    for (const email of set) {
      if (p.active.has(email)) continue;
      addPool(seen, { email, tier: "legacy", path });
    }
  }
  return [...seen.values()];
}

function makeInstance(
  program: string,
  row: RequirementRow,
  certKey: string,
  geo: GeoPlan,
  area: PlanArea,
  population: { country: string | null; populationKey: string; scopeLabel: string },
  figures: {
    attained: number;
    projectedAttained: number | null;
    gap: { shortfallNow: number; shortfallProjected: number | null; shortfall: number };
    pool: PoolMember[];
    expiringEmails: string[];
  },
): ReqInstance {
  return {
    id: `${program}::${row.id}::${population.populationKey}`,
    requirementKey: `${program}::${row.id}`,
    program,
    specialisation: row.specialisationName,
    tierName: null,
    purpose: row.purpose,
    nativeLevel: row.level,
    aggregation: row.aggregation,
    country: population.country,
    populationKey: population.populationKey,
    areaKey: area.areaKey,
    scopeLabel: population.scopeLabel,
    ...(geo.population ? { population: geo.population } : {}),
    isGate: false,
    certKey,
    cert: row.cert,
    certTitles: row.certTitles,
    titles: row.titles,
    label: row.label,
    required: row.quantityRequired,
    attained: figures.attained,
    projectedAttained: figures.projectedAttained,
    shortfallNow: figures.gap.shortfallNow,
    shortfallProjected: figures.gap.shortfallProjected,
    shortfall: figures.gap.shortfall,
    pool: figures.pool,
    poolEmails: new Set(figures.pool.map((m) => m.email)),
    expiringEmails: figures.expiringEmails,
  };
}

/** Build the requirement's scoped instance(s), resolving each gap and its
 *  candidate pools. Only requirements authored at a level the area has a
 *  population for are in play (mirroring the program dashboards) — others
 *  return no instance. A standard area has one population, so that is "the
 *  selected scope's own level"; a theatre area of a program with
 *  TargetCountries rows has two, so each row is counted over its OWN
 *  population (Theatre rows over the theatre, TargetCountries rows over the
 *  target countries). A pooled ("total") row gives one
 *  instance; an "each country" row gives one per country
 *  (`buildEachCountryInstances`). Pools are only computed when there's a gap. */
async function buildInstances(
  program: string,
  row: RequirementRow,
  area: PlanArea,
  idx: CatalogueIndex,
  now: Date,
  horizon: Date | null,
  planForWindow: boolean,
): Promise<ReqInstance[]> {
  const geo = area.populations.find((g) => g.reqLevel === row.level);
  if (!geo) return [];
  const certKey = certKeyFor(row, idx);
  if (row.aggregation === "eachCountry") {
    return buildEachCountryInstances(program, row, geo, area, idx, certKey, now, horizon, planForWindow);
  }

  const scope = geo.scope;
  const active = unionEmails(await getEmailSetsByTitle(row.titles, now, scope));
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
      const future = unionEmails(await getEmailSetsByTitle(row.titles, horizon, scope));
      projectedAttained = future.size;
      expiringEmails = [...active].filter((e) => !future.has(e));
    }
  }

  const gap = sizeGap(row.quantityRequired, attained, projectedAttained, planForWindow);

  let pool: PoolMember[] = [];
  if (gap.shortfall > 0) {
    const ilt = pathTitles(row, idx, idx.reverseCert);
    const lg = pathTitles(row, idx, idx.legacyForCert);
    const iltMap = ilt.titles.length > 0 ? await getEmailSetsByTitle(ilt.titles, now, scope) : undefined;
    const ever = await holdersEver(row.titles, scope);
    const lgMap = lg.titles.length > 0 ? await getEmailSetsByTitle(lg.titles, now, scope) : undefined;
    pool = assemblePool({
      active,
      expiringEmails,
      planForWindow,
      ilt: iltMap,
      iltFullFor: ilt.fullFor,
      ever,
      legacy: lgMap,
      legacyFullFor: lg.fullFor,
    });
  }

  return [
    makeInstance(
      program, row, certKey, geo, area,
      { country: null, populationKey: geo.populationKey, scopeLabel: geo.scopeLabel },
      { attained, projectedAttained, gap, pool, expiringEmails },
    ),
  ];
}

/**
 * An "each country" row: every country in the area must reach the quantity on
 * its own, so it becomes one instance per country — population = that country,
 * `scopeLabel` = the country, `required` = the row's quantity.
 *
 * **One bucketed query per row, never one per country.** Every holder set below
 * (active, at the horizon, the ILT/OLX easy-win paths, ever-held, legacy) is
 * fetched once over the whole area grouped by the holder's country and then
 * split, so the query count is flat in the number of countries. Looping
 * `buildInstances` per country instead would be ~6 queries × every country ×
 * every requirement — thousands on a worldwide set.
 *
 * An area with no countries at all (an unknown or emptied set, a region nobody
 * has configured) yields ONE placeholder instance with nothing attained and the
 * full quantity short. That is the dashboards' fail-closed rule — an empty
 * area is not compliant — and it keeps the requirement visible on the roadmap
 * rather than letting it vanish, which would read as "nothing to do".
 */
async function buildEachCountryInstances(
  program: string,
  row: RequirementRow,
  geo: GeoPlan,
  area: PlanArea,
  idx: CatalogueIndex,
  certKey: string,
  now: Date,
  horizon: Date | null,
  planForWindow: boolean,
): Promise<ReqInstance[]> {
  const countries = geo.countries ?? [];
  if (countries.length === 0) {
    const projectedAttained = horizon ? 0 : null;
    // The gap is sized from at least 1, so the placeholder is never met — not
    // even for a row whose quantity is 0 (a restored or SQL-written row the
    // write paths would not produce). With `quantityRequired` itself, 0 short
    // would read as achieved and count toward a tier, while the dashboard
    // reports the same row not compliant; `isAchievedNow`/`isAchievedAtHorizon`
    // read this shortfall too, so the badge and the tier gate agree with it.
    const gapFloor = Math.max(1, row.quantityRequired);
    return [
      makeInstance(
        program, row, certKey, geo, area,
        { country: null, populationKey: geo.populationKey, scopeLabel: geo.scopeLabel },
        {
          attained: 0,
          projectedAttained,
          gap: sizeGap(gapFloor, 0, projectedAttained, planForWindow),
          pool: [],
          expiringEmails: [],
        },
      ),
    ];
  }

  const scope = geo.scope;
  const activeBy = unionByCountry(await getEmailSetsByTitleAndGeo(row.titles, now, "country", scope));
  const anyActive = [...activeBy.values()].some((s) => s.size > 0);
  // Same shortcut as the pooled path: with nobody holding it anywhere there is
  // nothing to lose by the horizon.
  const futureBy =
    horizon && anyActive
      ? unionByCountry(await getEmailSetsByTitleAndGeo(row.titles, horizon, "country", scope))
      : null;

  const perCountry = countries.map((country) => {
    const active = activeBy.get(country) ?? new Set<string>();
    const attained = active.size;
    let expiringEmails: string[] = [];
    let projectedAttained: number | null = null;
    if (horizon) {
      if (attained === 0) {
        projectedAttained = 0;
      } else {
        const future = futureBy?.get(country) ?? new Set<string>();
        projectedAttained = future.size;
        expiringEmails = [...active].filter((e) => !future.has(e));
      }
    }
    const gap = sizeGap(row.quantityRequired, attained, projectedAttained, planForWindow);
    return { country, active, attained, projectedAttained, expiringEmails, gap };
  });

  // Pools, still one query each over the whole area, and only if some country
  // actually has a gap to fill.
  let iltBy: Map<string, Map<string, Set<string>>> | null = null;
  let everBy: Map<string, Set<string>> | null = null;
  let legacyBy: Map<string, Map<string, Set<string>>> | null = null;
  const ilt = pathTitles(row, idx, idx.reverseCert);
  const lg = pathTitles(row, idx, idx.legacyForCert);
  if (perCountry.some((p) => p.gap.shortfall > 0)) {
    iltBy =
      ilt.titles.length > 0
        ? pivotByCountry(await getEmailSetsByTitleAndGeo(ilt.titles, now, "country", scope))
        : null;
    everBy = await holdersEverByCountry(row.titles, scope);
    legacyBy =
      lg.titles.length > 0
        ? pivotByCountry(await getEmailSetsByTitleAndGeo(lg.titles, now, "country", scope))
        : null;
  }

  return perCountry.map((p) =>
    makeInstance(
      program, row, certKey, geo, area,
      { country: p.country, populationKey: `country:${p.country}`, scopeLabel: p.country },
      {
        attained: p.attained,
        projectedAttained: p.projectedAttained,
        gap: p.gap,
        pool:
          p.gap.shortfall > 0
            ? assemblePool({
                active: p.active,
                expiringEmails: p.expiringEmails,
                planForWindow,
                ilt: iltBy?.get(p.country),
                iltFullFor: ilt.fullFor,
                ever: everBy?.get(p.country),
                legacy: legacyBy?.get(p.country),
                legacyFullFor: lg.fullFor,
              })
            : [],
        expiringEmails: p.expiringEmails,
      },
    ),
  );
}

/** Keep the cheapest tier per email in a pool. */
function addPool(seen: Map<string, PoolMember>, m: Omit<PoolMember, "paths">): void {
  const existing = seen.get(m.email);
  if (!existing || TIER_RANK[m.tier] < TIER_RANK[existing.tier]) {
    seen.set(m.email, { ...m, paths: m.path ? [m.path] : [] });
  } else if (existing.tier === m.tier && m.path && !existing.paths.includes(m.path)) {
    // Same tier, another route there: keep it, so the person is shown with
    // every qualifying training they hold rather than an arbitrary one.
    existing.paths.push(m.path);
  }
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
      paths: member.paths,
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
 * The key two instances must share for one person's certification to be able to
 * count for both: the same qualifying cert-set within the same plan area.
 *
 * Within a group, instances are either **scope-wide** (`country === null`,
 * counted over a whole population of the area) or **per-country** (one country
 * of an "each country" requirement). Those are not interchangeable — see
 * `groupCost` and `sharesPopulation`. `areaKey` rather than `scopeLabel` is in
 * the key because a country set may be named like a country; and it is in the
 * key at all because collapsing two areas' gaps into one would fail silently
 * and expensively.
 *
 * **The invariant everything below rests on: the populations inside one area
 * are nested.** A standard scope has one population, so every scope-wide
 * instance of a group shares it. A theatre area of a program with
 * TargetCountries rows has a CHAIN — the theatre ⊇ target countries ⊇ each
 * target country — so its scope-wide instances can sit over two different
 * populations (a Theatre "total" row and a TargetCountries "total" row on one
 * cert), but one is always inside the other, and every
 * per-country instance is inside both. That is what makes the `max` in
 * `groupCost` a sound charge for the scope-wide side: one cohort of N new
 * holders placed in the INNERMOST population counts toward every scope-wide
 * instance of the group, so the largest gap is enough. If an area ever held
 * two populations that are NOT nested (two disjoint target sets), `max` would
 * under-count; `resolveTheatreTargetPlanArea` keys the area on both populations so
 * that can only happen by changing it.
 */
function certGroupKey(inst: ReqInstance): string {
  return `${inst.certKey}::${inst.areaKey}`;
}

/**
 * Whether one person's certification can count toward both instances: the same
 * cert within one area, unless they are two DIFFERENT countries' slices of an
 * "each country" requirement — someone certified in one country does nothing
 * for another's gap.
 *
 * Everything else in an area shares by the nesting invariant on `certGroupKey`:
 * the same population trivially; a scope-wide instance and a per-country one
 * because the country is inside every scope-wide population of the area; and
 * (theatre areas with target countries only) two scope-wide instances over
 * different populations, because a person certified in a target country is
 * inside the theatre too. For a single-population area that last case never
 * arises — every scope-wide instance has the one population.
 */
function sharesPopulation(a: ReqInstance, b: ReqInstance): boolean {
  if (certGroupKey(a) !== certGroupKey(b)) return false;
  if (a.country !== null && b.country !== null) return a.country === b.country;
  return true;
}

/**
 * The one dedup rule behind every "how many people" figure — `netNewTotal`,
 * `specSetCost` — applied to whatever per-instance value the caller supplies.
 *
 * Per `certGroupKey`, the cost is `max(P, Σ_c g_c)`:
 *  - `P` is the largest value among the group's scope-wide instances. They share
 *    one population (or, in a theatre area with target countries, nested ones —
 *    see `certGroupKey`),
 *    so a single cohort of N new holders placed in the innermost satisfies every
 *    one whose gap is ≤ N — three specialisations each needing 2 holders of the
 *    same cert cost 2 people, not 6.
 *  - `g_c` is the largest value among the per-country instances for country c
 *    (the same reasoning, one country at a time), and those are SUMMED: a person
 *    certified in one country does nothing for another's gap.
 *  - The max, not the sum, of the two sides because every per-country holder is
 *    also inside the area: people certified to close the countries' gaps count
 *    toward the area-wide total as well. "4 × Cert A in each country" beside
 *    "2 × Cert A total" is never charged twice — and in a theatre area "4 in
 *    each target country" beside "15 across the theatre" is
 *    `max(15 − have, Σ country gaps)`, never their sum.
 *
 * With no per-country instances this is exactly the old max-per-group rule, so a
 * plan built only from pooled requirements produces the same numbers it always
 * did. Pure — nothing here touches the database.
 */
export function groupCost(instances: Iterable<ReqInstance>, valueOf: (inst: ReqInstance) => number): number {
  const groups = new Map<string, { wide: number; byCountry: Map<string, number> }>();
  for (const inst of instances) {
    const key = certGroupKey(inst);
    let g = groups.get(key);
    if (!g) {
      g = { wide: 0, byCountry: new Map() };
      groups.set(key, g);
    }
    const v = valueOf(inst);
    if (inst.country === null) g.wide = Math.max(g.wide, v);
    else g.byCountry.set(inst.country, Math.max(g.byCountry.get(inst.country) ?? 0, v));
  }
  let total = 0;
  for (const g of groups.values()) {
    let perCountry = 0;
    for (const v of g.byCountry.values()) perCountry += v;
    total += Math.max(g.wide, perCountry);
  }
  return total;
}

/**
 * People still needing brand-new training across `instances`, counting a
 * certification required by several of them over the same population ONCE.
 *
 * This is the net-new half of the dedup `allocateCandidates` already performs for
 * named people, via `groupCost` over the post-allocation remainder per instance.
 *
 * Pure, like `allocateCandidates` — `alloc` supplies the post-allocation
 * remainder per instance and nothing here touches the database.
 */
export function netNewTotal(instances: ReqInstance[], alloc: AllocationResult): number {
  return groupCost(instances, (inst) => alloc.netNewByInstance.get(inst.id) ?? 0);
}

/**
 * People-moves to close a SET of specialisations, counting a certification
 * required by several of them over the same population once.
 *
 * The same `groupCost` rule as `netNewTotal`. Where this differs is what it costs
 * — the raw planning gap (`inst.shortfall`), because it ranks specialisations
 * *before* allocation has happened and so has no post-allocation remainder to
 * read.
 *
 * Pure and exported for the same reason `allocateCandidates` is: the tier
 * cheapest-path ranking it drives is the part worth exercising directly.
 */
export function specSetCost(
  names: Iterable<string>,
  bySpec: Map<string, ReqInstance[]>,
  /**
   * Instances paid for whatever is chosen — a tiered program's program-wide
   * requirements. Costed into every set, so a specialisation sharing a cert
   * with them ranks by what it adds on top. Empty for a program without them,
   * which leaves every pre-existing ranking unchanged.
   */
  alwaysCounted: ReqInstance[] = [],
): number {
  const insts: ReqInstance[] = [...alwaysCounted];
  for (const name of names) insts.push(...(bySpec.get(name) ?? []));
  return groupCost(insts, (inst) => inst.shortfall);
}

// ─── Tier fastest-path ───────────────────────────────────────────────────────

interface TierInfo {
  id: number;
  name: string;
  sortOrder: number;
  specialisationsRequired: number;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Whether a plan request can only be answered for exactly ONE company — the
 * rule both planning routes enforce — returning the 400's message, or null
 * when any scope will do. Kept here so the two surfaces cannot disagree about
 * either the rule or its wording:
 *  - a Country Set plan always (`COUNTRY_SET_SCOPE_ERROR`): a set name, and
 *    each partner's configured set and minimum, resolve only within one company;
 *  - a theatre plan only when some requested program has TargetCountries rows
 *    (`TARGET_COUNTRIES_SCOPE_ERROR`), whose target countries are that
 *    partner's Country Set. A theatre plan of
 *    programs without them keeps answering any scope, as it always has.
 * Mirrors the engine: target countries apply only when a theatre is named.
 */
export async function planRequiresSingleCompany(req: {
  level: ScopeLevel;
  theatre: string;
  targets: PlanTarget[];
}): Promise<string | null> {
  if (req.level === "countrySet") return COUNTRY_SET_SCOPE_ERROR;
  if (req.level !== "theatre" || !req.theatre.trim() || req.targets.length === 0) return null;
  const row = await prisma.programData.findFirst({
    where: { programName: { in: [...new Set(req.targets.map((t) => t.program))] }, level: "TargetCountries" },
    select: { id: true },
  });
  return row !== null ? TARGET_COUNTRIES_SCOPE_ERROR : null;
}

export async function computeCompliancePlan(input: CompliancePlanInput): Promise<CompliancePlanResult> {
  const now = new Date();
  const horizon = input.renewalWindowMonths > 0 ? addMonths(now, input.renewalWindowMonths) : null;
  // "Plan for the window" is meaningless without a window.
  const planForWindow = horizon !== null && input.planForWindow;

  const idx = await buildCatalogueIndex();
  // Every scope has one population shared by every target, except where the
  // partner's per-program terms decide the area: a theatre plan of a program
  // with TargetCountries rows, and a Country Set plan with no set named. Those
  // are resolved per program inside the loop.
  const sharedArea = standardArea(await resolveGeoPlan(input));
  const planTheatre = input.level === "theatre" ? input.theatre.trim() : "";
  const areaLabels: string[] = [];

  const targets: PlanTargetResult[] = [];

  // Per-target preparation captured before allocation: how its instances group
  // into specialisations, and — for a tier target — which specialisations the
  // plan is *costed against* (the cheapest `needed`, chosen by marginal cost) vs
  // which merely swap in for one of them at no extra cost.
  interface TargetPrep {
    target: PlanTargetResult;
    area: PlanArea;
    bySpec: Map<string, ReqInstance[]>;
    tierDeployInsts: ReqInstance[];
    /** A tiered program's program-wide requirements — always counted, never ranked. */
    gateInsts: ReqInstance[];
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
  // Every instance the roadmap renders — the chosen specialisations AND the
  // dimmed reference ones. The renewal overlay is built from this; `counted`
  // decides only which of those rows are on the recommended path. Scoping the
  // overlay to `countedInstances` is what let a WIDER renewal window report
  // FEWER renewals than a narrower one: the cheapest path is costed from a
  // window-dependent `shortfall`, so a specialisation dropping off the path
  // took its expiring holders out of the panel with it.
  const allInstances: ReqInstance[] = [];

  // Load every target's program and resolve the area it is planned over
  // first, so the theatre areas can be reconciled across targets before any
  // instance is built (see below).
  const loaded = [];
  /** Programs whose included theatres leave out the plan's theatre. */
  const excludedTheatrePrograms = new Set<string>();
  for (const target of input.targets) {
    const programRow = await prisma.program.findUnique({
      where: { name: target.program },
      select: {
        id: true,
        name: true,
        isTiered: true,
        countrySetMinimumCountries: true,
        targetMinimumCountries: true,
        includedTheatres: true,
      },
    });
    // A theatre plan in a theatre the program excludes plans nothing for it:
    // its Theatre and Target-countries rows are dropped below, and its
    // headline says why rather than reading as "compliant".
    const theatreExcluded =
      !!planTheatre && !!programRow && !isTheatreIncluded(planTheatre, programRow.includedTheatres);
    if (theatreExcluded) excludedTheatrePrograms.add(target.program);

    const [allProgramData, tierRows] = await Promise.all([
      prisma.programData.findMany({
        where: { programName: target.program },
        select: {
          id: true,
          specialisationId: true,
          tierId: true,
          purpose: true,
          level: true,
          aggregation: true,
          quantityRequired: true,
          trainingTitle: true,
          label: true,
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
    const programData = theatreExcluded
      ? allProgramData.filter((d) => d.level !== "Theatre" && d.level !== "TargetCountries")
      : allProgramData;

    // Which area this target is planned over (see `PlanArea`).
    let area: PlanArea = sharedArea;
    let countrySetMinimum: CountrySetMinimumMeta | null = null;
    if (programRow && planTheatre && programData.some((d) => d.level === "TargetCountries")) {
      area = await resolveTheatreTargetPlanArea(programRow, planTheatre, input);
    } else if (programRow && input.level === "countrySet") {
      const resolved = await resolveCountrySetMinimum({
        program: programRow,
        countrySet: input.countrySet,
        companyIds: input.companyIds,
      });
      // A scope that is not one company is refused by the routes; should a
      // caller skip that, the shared (empty) area stands and nothing is
      // resolved across tenants.
      if (!("error" in resolved)) {
        countrySetMinimum = resolved.meta;
        // A named set is the one shared area every program plans over; a
        // blank one is each program's own configured set.
        if (!input.countrySet.trim()) area = countrySetPlanArea(resolved.companyId, resolved.meta, [resolved.companyId]);
      }
    }
    loaded.push({ target, programRow, programData, tierRows, area, countrySetMinimum });
  }

  // A theatre plan mixing programs WITH target countries and programs without:
  // when every targets program resolved the SAME target population, all of
  // them — and the plain theatre programs — share one area keyed on both
  // populations. That is sound because the populations are still a nested
  // chain (the theatre ⊇ those target countries ⊇ each one), and it is what
  // lets one person certified for a cert two programs both need count once,
  // exactly as two plain theatre programs always have. Different target
  // populations keep their own per-program keys (disjoint target sets must
  // never share a group), which can over-count but never under-count.
  const theatreAreaKeys = new Set(
    loaded.filter((l) => l.area.areaKey.startsWith(THEATRE_TARGETS_AREA_PREFIX)).map((l) => l.area.areaKey),
  );
  if (theatreAreaKeys.size === 1) {
    const [key] = theatreAreaKeys;
    for (const l of loaded) if (l.area === sharedArea) l.area = { ...sharedArea, areaKey: key };
  }

  for (const { target, programRow, programData, tierRows, area, countrySetMinimum } of loaded) {
    if (!areaLabels.includes(area.scopeLabel)) areaLabels.push(area.scopeLabel);

    const isTiered = programRow?.isTiered === true;
    const rows = programData
      .map(toRequirementRow)
      .filter((r): r is RequirementRow => r !== null);
    // A program-wide requirement: a row with neither a specialisation nor a
    // tier, on a tiered program (the write path refuses one anywhere else).
    // Every tier requires it, so it is costed into every tier target exactly as
    // the tier's own delivery certs are — at every scope.
    const isGate = (r: RequirementRow) =>
      isTiered && isProgramWideRow({ specialisationId: r.specialisationId, tierId: r.tierId });

    // Which requirement rows are in play for this target's mode.
    const chosenTier: TierInfo | null =
      target.mode === "tier" && target.tier
        ? tierRows.find((t) => t.name === target.tier) ?? null
        : null;

    // Program-wide requirements per mode — a decision, so written down:
    //  - "tier": included and always counted. Reaching any tier requires them.
    //  - "all": included; the mode is every requirement of the program.
    //  - "specialisations": EXCLUDED. The caller named the specialisations they
    //    want planned, and a program-wide requirement belongs to none of them —
    //    pulling it in would cost something they did not ask about. (A tier
    //    target is how to plan "what does reaching a level take".)
    let activeRows: RequirementRow[];
    let restrictSpecs: Set<string> | null = null;
    if (target.mode === "specialisations" && target.specialisations && target.specialisations.length > 0) {
      restrictSpecs = new Set(target.specialisations);
      activeRows = rows.filter((r) => r.specialisationName && restrictSpecs!.has(r.specialisationName));
    } else if (target.mode === "tier") {
      // Tier target: all specialisation qualifying rows (to rank the cheapest K)
      // plus this tier's deployment rows plus the program-wide requirements.
      activeRows = rows.filter(
        (r) =>
          (r.specialisationName && r.purpose === "qualification") ||
          (chosenTier && r.tierId === chosenTier.id) ||
          isGate(r),
      );
    } else {
      activeRows = rows; // "all"
    }

    // Build instances for every active row (one scoped instance per in-scope row).
    const rowInstances: ReqInstance[] = [];
    for (const row of activeRows) {
      const built = await buildInstances(target.program, row, area, idx, now, horizon, planForWindow);
      // Tag tier-deployment instances with the tier name for display.
      if (chosenTier && row.tierId === chosenTier.id) {
        for (const b of built) b.tierName = chosenTier.name;
      }
      if (isGate(row)) for (const b of built) b.isGate = true;
      rowInstances.push(...built);
    }

    // Group instances into specialisation blocks + the tier's delivery certs +
    // the program-wide requirements.
    const bySpec = new Map<string, ReqInstance[]>();
    const tierDeployInsts: ReqInstance[] = [];
    const gateInsts: ReqInstance[] = [];
    for (const inst of rowInstances) {
      if (inst.isGate) {
        gateInsts.push(inst);
        continue;
      }
      if (inst.tierName && !inst.specialisation) {
        tierDeployInsts.push(inst);
        continue;
      }
      const key = inst.specialisation ?? "—";
      if (!bySpec.has(key)) bySpec.set(key, []);
      bySpec.get(key)!.push(inst);
    }

    // Which of this target's requirements are the *same* cert over a shared
    // population (`sharesPopulation` — the same rule `groupCost` charges by), so
    // the page can say why the per-specialisation figures add up to more than
    // the headline. Computed over every instance, counted or not — it is
    // informational, and a non-counted specialisation's requirement is just as
    // shared. `label` mirrors how the roadmap groups the rows. Instances are
    // bucketed by group first, so the pairwise test only runs within one cert.
    const specLabel = (inst: ReqInstance) =>
      inst.isGate ? PROGRAM_WIDE_BLOCK_NAME : inst.specialisation ?? inst.tierName ?? "—";
    const instancesByGroup = new Map<string, ReqInstance[]>();
    for (const inst of rowInstances) {
      const key = certGroupKey(inst);
      if (!instancesByGroup.has(key)) instancesByGroup.set(key, []);
      instancesByGroup.get(key)!.push(inst);
    }
    const sharedByInstanceId = new Map<string, string[]>();
    for (const inst of rowInstances) {
      const own = specLabel(inst);
      const others = new Set<string>();
      for (const other of instancesByGroup.get(certGroupKey(inst)) ?? []) {
        if (other === inst || !sharesPopulation(inst, other)) continue;
        const label = specLabel(other);
        if (label !== own) others.add(label);
      }
      sharedByInstanceId.set(inst.id, [...others].sort((a, b) => a.localeCompare(b)));
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
      ...(area.targetCountries ? { targetCountries: area.targetCountries } : {}),
      ...(countrySetMinimum ? { countrySetMinimum } : {}),
    };
    // The minimum-countries rule cannot be closed by certifying anyone, so it
    // is reported beside the plan and never costed. The per-country rows for
    // the countries that DO exist are still built and costed above.
    const blockers: PlanBlocker[] = [];
    const tc = area.targetCountries;
    if (tc && !tc.minimumMet && tc.minimumCountries !== null) {
      blockers.push({
        kind: "minimumCountries",
        view: "theatre",
        areaName: tc.theatre,
        required: tc.minimumCountries,
        counted: tc.targetCountries.length,
        source: tc.minimumCountriesSource,
      });
    }
    if (countrySetMinimum && !countrySetMinimum.minimumMet && countrySetMinimum.minimumCountries !== null) {
      blockers.push({
        kind: "minimumCountries",
        view: "countrySet",
        areaName: countrySetMinimum.countrySet,
        required: countrySetMinimum.minimumCountries,
        counted: countrySetMinimum.countries.length,
        source: countrySetMinimum.minimumCountriesSource,
      });
    }
    if (blockers.length > 0) targetResult.blockers = blockers;
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
      // Per-country instances need no special case: an "each country" row is
      // met only when every one of its countries is, and each country is its
      // own instance here (an empty area's placeholder is never met).
      const specAchieved = new Map<string, boolean>();
      for (const [name, insts] of bySpec) {
        specAchieved.set(name, insts.every((i) => i.shortfall === 0));
      }
      const achievedCount = [...specAchieved.values()].filter(Boolean).length;
      const needed = Math.max(0, chosenTier.specialisationsRequired - achievedCount);
      targetResult.tierPlan.alreadyAchieved = achievedCount;
      targetResult.tierPlan.needed = needed;
      // Deduped by the same rule as the totals, so the headline's "N more
      // delivery-cert people" cannot claim more than peopleMoves charges for
      // (two delivery rows on one cert, or a pooled row beside an each-country
      // one, are one cohort, not two).
      targetResult.tierPlan.deliveryCertShortfall = groupCost(tierDeployInsts, (i) => i.shortfall);
      if (gateInsts.length > 0) {
        targetResult.tierPlan.gateShortfall = groupCost(gateInsts, (i) => i.shortfall);
      }

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
        // The program-wide requirements are paid for whichever specialisations
        // are chosen, so they sit in every set's cost: a specialisation sharing
        // a cert with them adds only what they do not already cover.
        for (let i = 0; i < k; i++) {
          const base = specSetCost(chosenSpecs, bySpec, gateInsts);
          let best: string | null = null;
          let bestMarginal = Infinity;
          for (const name of pool) {
            const marginal = specSetCost([...chosenSpecs, name], bySpec, gateInsts) - base;
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
        const baseline = specSetCost(chosenSpecs, bySpec, gateInsts);
        for (const name of remaining) {
          if (marginalBySpec.has(name)) continue;
          const swaps = chosenSpecs.some(
            (c) => specSetCost([...chosenSpecs.filter((x) => x !== c), name], bySpec, gateInsts) <= baseline,
          );
          if (!swaps) continue;
          alternativeSpecs.add(name);
          marginalBySpec.set(name, specSetCost([...chosenSpecs, name], bySpec, gateInsts) - baseline);
        }

        for (const name of chosenSpecs) {
          for (const inst of bySpec.get(name)!) countedIds.add(inst.id);
        }
      }
      // Tier delivery certs and program-wide requirements always count toward the tier.
      for (const inst of tierDeployInsts) countedIds.add(inst.id);
      for (const inst of gateInsts) countedIds.add(inst.id);
    } else {
      // Non-tier targets: every instance counts.
      for (const inst of rowInstances) countedIds.add(inst.id);
    }

    const counted = rowInstances.filter((inst) => countedIds.has(inst.id));
    // Adjacent on purpose: a future target mode that populates one and forgets
    // the other is then a one-line diff rather than a silent divergence.
    countedInstances.push(...counted);
    allInstances.push(...rowInstances);
    preps.push({
      target: targetResult,
      area,
      bySpec,
      tierDeployInsts,
      gateInsts,
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

  // The recommended path as one flat set: a tier target's chosen specialisations
  // plus its delivery certs, or every instance of a non-tier target. Named in
  // full rather than `countedIds` — that name is the per-target Set above, and
  // the two are not the same thing.
  const countedInstanceIds = new Set(countedInstances.map((i) => i.id));

  // Student display info for every committed candidate + every renewal-at-risk
  // holder + every eligible pool member (so the full-pool list can be named).
  const candidateEmails = new Set<string>(alloc.closesByEmail.keys());
  // Renewal rows are reported for every roadmap instance, so every one of their
  // holders has to be named — an off-path holder would otherwise render as a
  // raw email address.
  for (const inst of allInstances) for (const e of inst.expiringEmails) candidateEmails.add(e);
  // Pools stay scoped to the counted instances: `eligible` below is built from
  // those alone, so widening this would fetch students nothing ever renders.
  for (const inst of countedInstances) for (const m of inst.pool) candidateEmails.add(m.email);
  const students = candidateEmails.size > 0
    ? await prisma.student.findMany({
        where: { email: { in: [...candidateEmails] } },
        select: { email: true, fullName: true, country: true, theatre: true },
      })
    : [];
  const studentById = new Map(students.map((s) => [s.email, s]));

  // ── Roll instances back up into the per-target roadmap ──
  for (const {
    target, area, bySpec, tierDeployInsts, gateInsts, counted, sharedByInstanceId,
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

    // The program-wide requirements lead the roadmap: every level needs them,
    // so they are on the path whatever the specialisations turn out to be.
    if (gateInsts.length > 0) {
      const gateReqs = gateInsts.map((inst) => toPlanRequirement(inst, alloc, shared(inst)));
      specs.unshift({
        name: PROGRAM_WIDE_BLOCK_NAME,
        kind: "programWide",
        achieved: isAchievedNow(gateReqs),
        projectedAchieved: isAchievedAtHorizon(gateReqs),
        // Deduped (`groupCost`) rather than the plain sum a specialisation's
        // `cost` is: this block typically pairs an "each target country" row
        // with a theatre-wide row on the same cert, and summing them would show
        // a figure the tier headline's `gateShortfall` beside it contradicts.
        cost: groupCost(gateInsts, (i) => i.shortfall),
        easyWins: gateInsts.reduce((s, i) => s + i.pool.filter((p) => p.tier === "easy-win").length, 0),
        requirements: gateReqs,
        // Counted for a tier target exactly like the delivery certs; a non-tier
        // target sets no role on any block.
        ...(target.tierPlan ? { chosen: true } : {}),
      });
    }

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
    target.headline = excludedTheatrePrograms.has(target.program)
      ? `${planTheatre} is not one of ${target.program}'s theatres, so nothing is planned for it there.`
      : buildHeadline(target, area.scopeLabel, input.renewalWindowMonths);
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
        paths: m.paths,
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

  // ── The renewal overlay ──
  // Both halves are built over EVERY roadmap instance and marked `onPath`,
  // rather than filtered down to the counted ones — see `buildRenewalRows`.
  // They stay on the server because only this side knows which instances are
  // counted: reproducing the flag on the client would mean re-deriving the
  // chosen specialisations *and* the tier's delivery certs.
  const riskImpacts = buildRiskImpacts(allInstances, countedInstanceIds);
  const renewals = await buildRenewalRows(allInstances, countedInstanceIds, studentById, now, horizon);

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
    // The shared area's label; a Country Set plan with no set named names each
    // set its targets resolved to (each program may be configured differently).
    scopeLabel: areaLabels.length > 0 ? areaLabels.join("; ") : sharedArea.scopeLabel,
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
      renewalsAtRisk: renewals.length,
      renewalsAtRiskOnPath: renewals.filter((r) => r.onPath).length,
    },
  };
}

// ─── The renewal overlay ─────────────────────────────────────────────────────

/** Split a plan's instances into the ones on the recommended path and the rest.
 *  Both overlay builders walk them in that order, so a row reachable from both
 *  sides is marked `onPath`. */
function splitByPath(all: ReqInstance[], countedInstanceIds: Set<string>): [ReqInstance[], ReqInstance[]] {
  const onPath: ReqInstance[] = [];
  const offPath: ReqInstance[] = [];
  for (const inst of all) (countedInstanceIds.has(inst.id) ? onPath : offPath).push(inst);
  return [onPath, offPath];
}

/**
 * The requirements the window's expiries break — over EVERY roadmap instance,
 * not just the counted ones. `shortfallProjected` is computed for every
 * instance regardless of counted-ness, so the filter is unchanged; the source
 * set and the `onPath` marker are what is new.
 */
function buildRiskImpacts(all: ReqInstance[], countedInstanceIds: Set<string>): PlanRiskImpact[] {
  const [onPath, offPath] = splitByPath(all, countedInstanceIds);
  return [...onPath, ...offPath]
    .filter((i) => i.shortfallProjected !== null && i.shortfallProjected > 0 && i.expiringEmails.length > 0)
    .map((i) => ({
      program: i.program,
      specialisation: i.specialisation,
      tierName: i.tierName,
      cert: i.cert,
      certTitles: i.certTitles,
      label: i.label,
      aggregation: i.aggregation,
      country: i.country,
      scopeLabel: i.scopeLabel,
      ...(i.population ? { population: i.population } : {}),
      required: i.required,
      attained: i.attained,
      projectedAttained: i.projectedAttained ?? i.attained,
      onPath: countedInstanceIds.has(i.id),
    }))
    .sort(
      (a, b) =>
        // On-path requirements lead: those are the ones the plan is costed
        // against, and the ones the copy above the table speaks for.
        Number(b.onPath) - Number(a.onPath) ||
        // Then the ones that are fine today — those are the surprising ones.
        Number(b.attained >= b.required) - Number(a.attained >= a.required) ||
        (b.required - b.projectedAttained) - (a.required - a.projectedAttained) ||
        a.cert.localeCompare(b.cert),
    );
}

/**
 * One row per (person, certification) whose training lapses inside the window,
 * over EVERY roadmap instance — not just the ones the plan is costed against,
 * which is what let a wider window report FEWER renewals than a narrower one:
 * the cheapest path is costed from a window-dependent gap and shifts as the
 * window widens, and a specialisation dropping off it took its expiring holders
 * out of the panel with it.
 *
 * The counted instances are walked FIRST, because the dedupe key is
 * `email + cert` and the first instance to claim a pair owns the row: a single
 * merged pass would make `onPath` depend on instance ordering and could file an
 * on-path renewal under "reference", under copy that says it is not counted.
 *
 * The key used to carry `scopeLabel` too, which was harmless while every
 * instance of a plan shared one population. It no longer does: a person
 * expiring in country C is in both the per-country instance of an "each
 * country" row (labelled C) and a pooled row on the same cert (labelled with
 * the area), and is still one renewal to book, not two.
 */
async function buildRenewalRows(
  all: ReqInstance[],
  countedInstanceIds: Set<string>,
  studentById: Map<string, { fullName: string; country: string; theatre: string }>,
  now: Date,
  horizon: Date | null,
): Promise<PlanRenewalRow[]> {
  const rows: PlanRenewalRow[] = [];
  // The instance each row came from, for the held-training lookup below.
  const sourceOf = new Map<PlanRenewalRow, ReqInstance>();
  const seen = new Set<string>();
  const collect = (instances: ReqInstance[], onPath: boolean) => {
    for (const inst of instances) {
      for (const email of inst.expiringEmails) {
        const k = `${email} ${inst.cert}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const s = studentById.get(email);
        const row: PlanRenewalRow = {
          email,
          fullName: s?.fullName ?? email,
          country: s?.country ?? "",
          theatre: s?.theatre ?? "",
          cert: inst.cert,
          certTitles: inst.certTitles,
          label: inst.label,
          heldTraining: null,
          expiresOn: null,
          scopeLabel: inst.scopeLabel,
          onPath,
        };
        rows.push(row);
        sourceOf.set(row, inst);
      }
    }
  };
  const [onPath, offPath] = splitByPath(all, countedInstanceIds);
  collect(onPath, true);
  collect(offPath, false);
  // The on-path key leads here too: without it this sort would undo the
  // two-pass ordering the page groups on.
  rows.sort(
    (a, b) =>
      Number(b.onPath) - Number(a.onPath) ||
      a.fullName.localeCompare(b.fullName) ||
      a.cert.localeCompare(b.cert),
  );
  await attachLapsingCompletions(rows, sourceOf, now, horizon);
  return rows;
}

/**
 * Name the certification each renewal row is about — the one the person holds
 * that lapses inside the window — and when it lapses, so the page can say
 * "Cert A, expires 12 Mar" instead of repeating the requirement's whole list of
 * alternatives. One query for every row: the holders' completions of every
 * qualifying title (sibling-expanded, as the counts are) that are active now
 * and expire by the horizon. A holder is "expiring" exactly when every
 * qualifying completion they hold ends inside the window, so each of theirs
 * falls in that range; the latest is when they stop counting. Display only —
 * nothing here feeds a count, and a row it cannot match keeps nulls.
 */
async function attachLapsingCompletions(
  rows: PlanRenewalRow[],
  sourceOf: Map<PlanRenewalRow, ReqInstance>,
  now: Date,
  horizon: Date | null,
): Promise<void> {
  if (rows.length === 0 || !horizon) return;
  const requested = [...new Set(rows.flatMap((r) => sourceOf.get(r)?.titles ?? []))];
  if (requested.length === 0) return;
  const { fetchTitles, groupMembers } = await resolveSiblingTitles(requested);
  const completions = await prisma.trainingTaken.findMany({
    where: {
      email: { in: [...new Set(rows.map((r) => r.email))] },
      trainingTitle: { in: fetchTitles },
      completedDate: { lte: now },
      expiryDate: { gt: now, lte: horizon },
    },
    select: { email: true, trainingTitle: true, expiryDate: true, trainingData: { select: { fullTitle: true } } },
  });
  const byEmail = new Map<string, typeof completions>();
  for (const c of completions) {
    const list = byEmail.get(c.email);
    if (list) list.push(c);
    else byEmail.set(c.email, [c]);
  }
  for (const row of rows) {
    const inst = sourceOf.get(row);
    if (!inst) continue;
    const qualifying = new Set(inst.titles.flatMap((t) => groupMembers.get(t) ?? [t]));
    let latest: (typeof completions)[number] | null = null;
    for (const c of byEmail.get(row.email) ?? []) {
      if (!qualifying.has(c.trainingTitle)) continue;
      if (!latest || c.expiryDate > latest.expiryDate) latest = c;
    }
    if (latest) {
      row.heldTraining = latest.trainingData?.fullTitle ?? latest.trainingTitle;
      row.expiresOn = latest.expiryDate.toISOString();
    }
  }
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function tierOrder(t: CandidateTier): number {
  return t === "renewal" ? -1 : t === "easy-win" ? 0 : t === "lapsed" ? 1 : t === "legacy" ? 2 : 3;
}

/**
 * Met today — the plain requirement check, independent of the planning basis.
 * The shortfall test is redundant for an ordinary row (its shortfall is exactly
 * `max(0, required - attained)`) and is what keeps an empty-area "each country"
 * placeholder unmet even when its quantity is 0 (see `buildEachCountryInstances`).
 */
function isAchievedNow(reqs: PlanRequirement[]): boolean {
  return reqs.every((r) => r.attained >= r.required && r.shortfall === 0);
}

/** Still met at the end of the renewal window; null when no window is selected. */
function isAchievedAtHorizon(reqs: PlanRequirement[]): boolean | null {
  if (reqs.some((r) => r.projectedAttained === null)) return null;
  return reqs.every(
    (r) => (r.projectedAttained ?? r.attained) >= r.required && (r.projectedShortfall ?? r.shortfall) === 0,
  );
}

function toPlanRequirement(
  inst: ReqInstance,
  alloc: AllocationResult,
  sharedWith: string[],
): PlanRequirement {
  return {
    instanceId: inst.id,
    requirementKey: inst.requirementKey,
    specialisation: inst.specialisation,
    tierName: inst.tierName,
    purpose: inst.purpose,
    nativeLevel: inst.nativeLevel,
    aggregation: inst.aggregation,
    country: inst.country,
    scopeLabel: inst.scopeLabel,
    ...(inst.population ? { population: inst.population } : {}),
    cert: inst.cert,
    certTitles: inst.certTitles,
    label: inst.label,
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

/**
 * The blocker sentence, in the page's voice: what to do and where, then why.
 * Shared by the headline; the page renders `blockers` itself too (restating
 * this — keep the two in step).
 */
export function blockerText(b: PlanBlocker, tiered: boolean): string {
  const more = Math.max(0, b.required - b.counted);
  const whose = b.source === "partner" ? "this partner's minimum" : "the program's default minimum";
  const action =
    b.view === "theatre"
      ? `Name ${more} more target countr${more === 1 ? "y" : "ies"}${b.areaName ? ` in ${b.areaName}` : ""} in Admin › Country Sets`
      : `Add ${more} more countr${more === 1 ? "y" : "ies"} to ${b.areaName ?? "a Country Set (none is configured for this partner)"} in Admin › Country Sets`;
  return (
    `${action} — ` +
    // A program without tiers has no tier to withhold.
    `${b.counted} of ${b.required} counted (${whose})${tiered ? ", and no tier is reached until then" : ""}.`
  );
}

function buildHeadline(target: PlanTargetResult, scopeLabel: string, windowMonths: number): string {
  const body = buildHeadlineBody(target, scopeLabel, windowMonths);
  // A blocker leads: certifying people cannot clear it, so a reader who acts on
  // the rest of the sentence alone would still not reach the target.
  const blockers = target.blockers ?? [];
  return blockers.length > 0 ? `${blockers.map((b) => blockerText(b, target.isTiered)).join(" ")} ${body}` : body;
}

function buildHeadlineBody(target: PlanTargetResult, scopeLabel: string, windowMonths: number): string {
  const where = scopeLabel === "Global" ? "globally" : `in ${scopeLabel}`;
  if (target.peopleMoves === 0 && (target.blockers?.length ?? 0) > 0) {
    // Never "fully compliant" while a blocker stands.
    return `Otherwise, nobody is left to certify ${where}.`;
  }
  if (target.peopleMoves === 0) {
    // Don't claim "nobody left to certify" when the window says otherwise: a
    // specialisation met today can still fall below target as training expires.
    // The program-wide block is not a specialisation, so it is named on its
    // own rather than counted as one ("1 specialisation falls below target"
    // when no specialisation does).
    const atRisk = target.specialisations.filter(
      (s) => !s.kind && s.achieved && s.projectedAchieved === false,
    );
    const gatesAtRisk = target.specialisations.some(
      (s) => s.kind === "programWide" && s.achieved && s.projectedAchieved === false,
    );
    if (atRisk.length > 0 || gatesAtRisk) {
      const n = atRisk.length;
      const what = [
        ...(gatesAtRisk ? ["the requirements every level needs"] : []),
        ...(n > 0 ? [`${n} specialisation${n === 1 ? "" : "s"}`] : []),
      ].join(" and ");
      const plural = n > 1 || gatesAtRisk;
      return (
        `${target.program} is compliant ${where} today, but ${what} ` +
        `fall${plural ? "" : "s"} below target within ${windowMonths} month${windowMonths === 1 ? "" : "s"} ` +
        `as training expires — renew to hold ${plural ? "them" : "it"}.`
      );
    }
    return `${target.program} is fully compliant ${where} — nobody left to certify.`;
  }
  const noun = target.peopleMoves === 1 ? "person" : "people";
  const easy = target.easyWins > 0 ? `, ${target.easyWins} of them easy wins` : "";
  if (target.tierPlan && target.tierName) {
    const { needed, deliveryCertShortfall, gateShortfall } = target.tierPlan;
    const parts: string[] = [];
    if (gateShortfall && gateShortfall > 0) {
      parts.push(
        `${gateShortfall} ${gateShortfall === 1 ? "person" : "people"} for the requirements every level needs`,
      );
    }
    if (needed > 0) {
      // `chosen` is exactly `needed` long, and each figure is the specialisation's
      // *marginal* cost — so the listed parts add up to the headline's total
      // instead of overstating it by charging a shared certification twice.
      const rec = target.specialisations.filter(
        (s) => s.chosen && !s.kind && !s.name.endsWith("delivery certs"),
      );
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
        .filter((s) => s.alternative && !s.kind && !s.name.endsWith("delivery certs"))
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
