import type { CompliancePlanResult, PlanTarget } from "@/lib/compliance-plan";

/**
 * Request parsing shared by the two Compliance Planning routes — the internal
 * one at `/api/programs/planning` (JWT) and the public one at
 * `/api/public/v1/programs/planning` (API key).
 *
 * It lives here rather than in either route because the public surface is where
 * lax parsing gets probed, and two copies of a validation rule is how one of
 * them ends up clamping a value the other does not. The company scope is
 * deliberately NOT parsed here: each surface resolves that its own way (session
 * role vs API-key grant), which is the one thing that genuinely differs.
 */

/** The renewal windows the UI offers; anything else falls back to 3 months. */
const WINDOW_OPTIONS = [0, 1, 3, 6, 12];

export interface ParsedPlanRequest {
  targets: PlanTarget[];
  /** The raw `targets` string, for the cache key. Empty when absent. */
  rawTargets: string;
  level: string;
  country: string;
  region: string;
  theatre: string;
  renewalWindowMonths: number;
  planForWindow: boolean;
}

/**
 * Parse the plan query string. Returns `null` when `targets` is present but not
 * valid JSON — the caller turns that into a 400. A *missing* `targets` is not an
 * error: it parses to an empty list, which both routes answer with an empty
 * plan, matching a page that has not chosen a target yet.
 */
export function parsePlanRequest(p: URLSearchParams): ParsedPlanRequest | null {
  let targets: PlanTarget[] = [];
  const rawTargets = p.get("targets");
  if (rawTargets) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawTargets);
    } catch {
      return null;
    }
    if (Array.isArray(parsed)) {
      targets = parsed
        .filter((t) => t && typeof t.program === "string")
        .map((t) => ({
          program: String(t.program),
          mode: t.mode === "tier" || t.mode === "specialisations" ? t.mode : "all",
          tier: typeof t.tier === "string" ? t.tier : undefined,
          specialisations: Array.isArray(t.specialisations)
            ? t.specialisations.map((s: unknown) => String(s))
            : undefined,
        }));
    }
  }

  const rawWindow = parseInt(p.get("renewalWindowMonths") || "3", 10);
  const renewalWindowMonths = WINDOW_OPTIONS.includes(rawWindow) ? rawWindow : 3;

  return {
    targets,
    rawTargets: rawTargets ?? "",
    level: p.get("level") || "global",
    country: p.get("country") || "",
    region: p.get("region") || "",
    theatre: p.get("theatre") || "",
    renewalWindowMonths,
    // Normalised so `renewalWindowMonths=0&planForWindow=true` can neither reach
    // the engine nor split the cache — with no horizon there is nothing to plan
    // for.
    planForWindow: renewalWindowMonths > 0 && p.get("planForWindow") === "true",
  };
}

/** The cache-key fragment covering every result-affecting plan parameter. */
export function planCacheKeyParts(req: ParsedPlanRequest): string {
  return [
    encodeURIComponent(req.rawTargets),
    req.level,
    req.country,
    req.region,
    req.theatre,
    req.renewalWindowMonths,
    req.planForWindow ? "plan" : "status",
  ].join("|");
}

/** The "nothing to plan" payload — the full result shape, so a client never has
 *  to null-guard fields the type says are always there. */
export function emptyCompliancePlan(renewalWindowMonths: number): CompliancePlanResult {
  return {
    scopeLabel: "",
    renewalWindowMonths,
    planForWindow: false,
    targets: [],
    candidates: [],
    eligible: [],
    renewals: [],
    riskImpacts: [],
    totals: {
      peopleMoves: 0, easyWins: 0, lapsed: 0, legacy: 0, netNew: 0,
      renewalMoves: 0, renewalsAtRisk: 0, renewalsAtRiskOnPath: 0,
    },
  };
}
