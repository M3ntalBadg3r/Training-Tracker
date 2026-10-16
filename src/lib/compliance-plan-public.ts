import type {
  CompliancePlanResult,
  PlanBlocker,
  PlanRequirement,
  PlanRiskImpact,
  PlanSpecialisation,
  PlanTargetResult,
} from "@/lib/compliance-plan";
import type { CountrySetMinimumMeta, TargetCountriesMeta } from "@/lib/program-levels";

/**
 * The aggregates-only view of a compliance plan, for the read-only public API.
 *
 * The internal plan names individuals: `candidates` and `eligible` are
 * `PlanCandidate[]` and `renewals` is `PlanRenewalRow[]`, each carrying an
 * `email` and a `fullName`. A partner-facing API key should be able to read the
 * *shape and cost* of a compliance gap without being handed a roster of named
 * staff, so those three fields are dropped here and nothing replaces them.
 *
 * Nothing analytical is lost by that. `riskImpacts` is the aggregate view of the
 * very set `renewals` enumerates (same instances, same `onPath` marker), and
 * `totals.renewalsAtRisk` is its count — so the public caller still learns which
 * requirements the upcoming expiries break and how many renewals are at stake,
 * just not who they are.
 *
 * ── Two rules here are load-bearing. Do not "simplify" either one. ──
 *
 * 1. `PublicCompliancePlan` is written out by hand. It is deliberately NOT
 *    `Omit<CompliancePlanResult, "candidates" | "eligible" | "renewals">`: that
 *    is a denylist wearing a type's clothing. A fourth person-level field added
 *    to the engine later would flow straight out to the public API through an
 *    `Omit`, with no compile error and no reviewer signal — the exact fail-open
 *    shape CLAUDE.md's "what a handler returns is an allowlist, not a denylist"
 *    rule exists to prevent (see `lib/credential-config.ts` for the incident
 *    that produced it).
 *
 * 2. `toPublicCompliancePlan` names every field it emits, one at a time. It
 *    never spreads the result and deletes keys. Combined with (1), a new field
 *    on `CompliancePlanResult` is inert here until somebody deliberately adds it
 *    in both places — which is the point.
 *
 * `targets` and `riskImpacts` are re-exported by reference rather than rebuilt:
 * `PlanTargetResult` (and the `PlanSpecialisation`/`PlanRequirement` it nests)
 * and `PlanRiskImpact` are counts, labels and certification names throughout —
 * verified field by field, no person identifier at any depth. If one of those
 * ever gains an email or a name, it must be projected here too.
 *
 * Re-audited when count modes arrived: `PlanRequirement` gained
 * `requirementKey` (`program::programDataId`), `aggregation` (an enum) and
 * `country` (a geography name), and `PlanRiskImpact` gained `aggregation` and
 * `country`. None identifies a person, so the by-reference pass-through stands.
 * A per-country instance's `scopeLabel` is a country name for the same reason.
 * (`PlanCandidateClose.scopeLabel` becomes a country too, but closes live only
 * under `candidates`/`eligible`, which never reach this surface.)
 *
 * Re-audited for requirement names: `PlanRequirement` and `PlanRiskImpact`
 * gained `label`, the optional display name a SuperAdmin gives a program
 * requirement (e.g. "4 per target country — any sales cert"). Program
 * definitions are global registry data authored in Admin › Program Data, so it
 * is catalogue text like `cert`, not a person identifier.
 *
 * Re-audited for program-wide requirements: `PlanTargetResult` gained
 * `blockers` and `tierPlan.gateShortfall` (an integer); `PlanSpecialisation`
 * gained `kind` (an enum).
 *
 * Re-audited again for target countries and per-view minimums, which replaced
 * an earlier single-view mode (its target-level meta and its `skippedTargets`
 * list are gone — every program is now plannable at every scope, so nothing is
 * ever skipped). `PlanTargetResult` now carries `targetCountries` (a
 * `TargetCountriesMeta`: the viewed theatre, the target Country Set's name,
 * the in-theatre and out-of-theatre country names, the minimum, its source and
 * whether it is met) on a theatre plan of a program with TargetCountries rows,
 * and `countrySetMinimum` (a `CountrySetMinimumMeta`: the set's name, its
 * member country names, the minimum, its source and whether it is met) on a
 * Country Set plan. `PlanBlocker` is a kind, a view enum, a theatre or set
 * name, two integers and a source enum. `PlanRequirement` and `PlanRiskImpact`
 * carry `population` (an enum). Counts, geography names and set names of the
 * key's own single company (both views are refused for any other scope) — no
 * person identifier. A target's `headline` may lead with `blockerText`, which
 * interpolates only integers and that theatre or set name. The by-reference
 * pass-through stands.
 *
 * Because those nested types pass through by reference, a field added to any
 * of them would reach partners unreviewed. The second block of assertions at
 * the bottom of this file classifies every field of every nested type, so such
 * an addition fails typecheck here and forces exactly that re-audit.
 */
export interface PublicCompliancePlan {
  scopeLabel: string;
  renewalWindowMonths: number;
  planForWindow: boolean;
  targets: PlanTargetResult[];
  riskImpacts: PlanRiskImpact[];
  totals: {
    peopleMoves: number;
    easyWins: number;
    lapsed: number;
    legacy: number;
    netNew: number;
    renewalMoves: number;
    renewalsAtRisk: number;
    renewalsAtRiskOnPath: number;
  };
}

/** Project a full plan down to the public, aggregates-only payload. */
export function toPublicCompliancePlan(plan: CompliancePlanResult): PublicCompliancePlan {
  return {
    scopeLabel: plan.scopeLabel,
    renewalWindowMonths: plan.renewalWindowMonths,
    planForWindow: plan.planForWindow,
    targets: plan.targets,
    riskImpacts: plan.riskImpacts,
    totals: {
      peopleMoves: plan.totals.peopleMoves,
      easyWins: plan.totals.easyWins,
      lapsed: plan.totals.lapsed,
      legacy: plan.totals.legacy,
      netNew: plan.totals.netNew,
      renewalMoves: plan.totals.renewalMoves,
      renewalsAtRisk: plan.totals.renewalsAtRisk,
      renewalsAtRiskOnPath: plan.totals.renewalsAtRiskOnPath,
    },
  };
}

/**
 * Compile-time proof that every field of `CompliancePlanResult` has been
 * consciously classified as public or withheld.
 *
 * Rule (1) above makes the projection fail *closed* — a new person-level field
 * cannot leak. That alone would be silently lossy in the other direction: a new
 * *aggregate* would never reach partners and nothing would say so. This closes
 * that: add a tenth field to `CompliancePlanResult` and `npm run typecheck`
 * fails right here, pointing at the decision that has to be made.
 *
 * `WITHHELD_PLAN_FIELDS` is NOT a denylist in the sense the allowlist rule
 * forbids — it builds no response and is never read at runtime. It exists only
 * so this exhaustiveness check can tell "deliberately withheld" apart from "not
 * yet classified". The response is still assembled solely from the fields named
 * in `toPublicCompliancePlan`.
 */
type PublicPlanField =
  | "scopeLabel"
  | "renewalWindowMonths"
  | "planForWindow"
  | "targets"
  | "riskImpacts"
  | "totals";

/** Classified as person-level and deliberately never sent to the public API. */
type WithheldPlanField = "candidates" | "eligible" | "renewals";

type UnclassifiedPlanField = Exclude<
  keyof CompliancePlanResult,
  PublicPlanField | WithheldPlanField
>;

// If this errors, a field was added to `CompliancePlanResult` without being
// classified above. Decide whether it is an aggregate (add it to
// `PublicPlanField` *and* to `PublicCompliancePlan` *and* to
// `toPublicCompliancePlan`) or person-level (add it to `WithheldPlanField`
// only, and let it stay out of the payload).
type _EveryPlanFieldIsClassified = UnclassifiedPlanField extends never ? true : never;
const _planFieldsAreExhaustive: _EveryPlanFieldIsClassified = true;
void _planFieldsAreExhaustive;

// And the reverse direction: the emitted interface must carry exactly the
// fields classified as public — no more (a withheld field sneaking in) and no
// fewer (a public field classified but never actually emitted).
type _PublicShapeMatchesClassification =
  keyof PublicCompliancePlan extends PublicPlanField
    ? PublicPlanField extends keyof PublicCompliancePlan
      ? true
      : never
    : never;
const _publicShapeIsCorrect: _PublicShapeMatchesClassification = true;
void _publicShapeIsCorrect;

// ── The nested types, held to the same discipline ───────────────────────────
// `targets` and `riskImpacts` are passed through BY REFERENCE, so every field
// of the types below reaches the public API. Each list here is the audited set:
// a field added to one of these types without being added here fails typecheck,
// which is the prompt to check it carries no person identifier (and, if one
// ever does, to project that type here instead of passing it through).
type AuditedTargetField =
  | "program" | "mode" | "isTiered" | "tierName" | "headline" | "tierPlan"
  | "specialisations" | "peopleMoves" | "easyWins" | "netNew" | "targetCountries"
  | "countrySetMinimum" | "blockers";
type AuditedSpecialisationField =
  | "name" | "achieved" | "projectedAchieved" | "cost" | "easyWins" | "requirements"
  | "chosen" | "alternative" | "marginalCost" | "kind";
type AuditedRequirementField =
  | "instanceId" | "requirementKey" | "specialisation" | "tierName" | "purpose" | "nativeLevel"
  | "aggregation" | "country" | "scopeLabel" | "population" | "cert" | "label" | "required" | "attained"
  | "projectedAttained" | "shortfall" | "projectedShortfall" | "renewalPool" | "easyWinPool"
  | "lapsedPool" | "legacyPool" | "netNew" | "sharedWith" | "expiringSoon";
type AuditedRiskImpactField =
  | "program" | "specialisation" | "tierName" | "cert" | "label" | "aggregation" | "country" | "scopeLabel"
  | "population" | "required" | "attained" | "projectedAttained" | "onPath";
type AuditedTierPlanField =
  | "specialisationsRequired" | "alreadyAchieved" | "needed" | "deliveryCertShortfall" | "gateShortfall";
type AuditedBlockerField = "kind" | "view" | "areaName" | "required" | "counted" | "source";
type AuditedTargetCountriesMetaField =
  | "theatre" | "countrySet" | "targetCountries" | "outOfTheatreCountries"
  | "minimumCountries" | "minimumCountriesSource" | "minimumMet";
type AuditedCountrySetMinimumMetaField =
  | "countrySet" | "countries" | "minimumCountries" | "minimumCountriesSource" | "minimumMet";

/** `true` only when `T`'s keys are exactly `K` — both directions, like the pair above. */
type KeysExactly<T, K extends PropertyKey> =
  [Exclude<keyof T, K>] extends [never] ? ([Exclude<K, keyof T>] extends [never] ? true : never) : never;

const _nestedFieldsAreAudited: [
  KeysExactly<PlanTargetResult, AuditedTargetField>,
  KeysExactly<PlanSpecialisation, AuditedSpecialisationField>,
  KeysExactly<PlanRequirement, AuditedRequirementField>,
  KeysExactly<PlanRiskImpact, AuditedRiskImpactField>,
  KeysExactly<NonNullable<PlanTargetResult["tierPlan"]>, AuditedTierPlanField>,
  KeysExactly<PlanBlocker, AuditedBlockerField>,
  KeysExactly<TargetCountriesMeta, AuditedTargetCountriesMetaField>,
  KeysExactly<CountrySetMinimumMeta, AuditedCountrySetMinimumMetaField>,
] = [true, true, true, true, true, true, true, true];
void _nestedFieldsAreAudited;
