import type {
  CompliancePlanResult,
  PlanRiskImpact,
  PlanTargetResult,
} from "@/lib/compliance-plan";

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
