import { NextRequest, NextResponse } from "next/server";
import { authorizePublicRequest } from "@/lib/public-api";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import { computeCompliancePlan } from "@/lib/compliance-plan";
import { toPublicCompliancePlan } from "@/lib/compliance-plan-public";
import {
  parsePlanRequest,
  planCacheKeyParts,
  emptyCompliancePlan,
} from "@/lib/compliance-plan-request";
import { buildPlanningOptions } from "@/lib/planning-options";

/**
 * GET /api/public/v1/programs/planning — read-only Compliance Planning, the
 * API-key counterpart of the internal `/api/programs/planning` route. Both are
 * thin wrappers over `lib/compliance-plan.ts` and share their request parsing
 * (`lib/compliance-plan-request.ts`), so the two surfaces cannot drift.
 *
 * **This surface is aggregates-only.** The internal plan names individuals —
 * `candidates`, `eligible` and `renewals` each carry an email and a full name —
 * and none of those reach an API key. Everything is projected through
 * `toPublicCompliancePlan`, an allowlist that names the fields it emits and is
 * held to the shape of `CompliancePlanResult` by a compile-time exhaustiveness
 * check, so a person-level field added to the engine later cannot leak here.
 * What survives is the roadmap, the per-requirement gaps and costs,
 * `riskImpacts` (the aggregate view of the very set `renewals` enumerates) and
 * `totals` — so a partner still learns which requirements upcoming expiries
 * break and how many renewals are at stake, just not who they are.
 *
 * Two modes, mirroring the internal route:
 *  - `?options=true` → per-program selector metadata (name, isTiered, levels,
 *    tier names, specialisation names) so a caller can build a `targets` array.
 *    `/api/public/v1/programs` deliberately carries no tier or specialisation
 *    *names*, so without this a partner cannot construct a valid target.
 *  - default (plan) → the aggregates-only plan for the selected targets + scope.
 *
 * Query params (identical to the internal route):
 *  - `targets`  URL-encoded JSON array:
 *      [{ program, mode: "tier"|"specialisations"|"all", tier?, specialisations?[] }]
 *  - `level`    global (default) | theatre | region | country
 *  - `country` / `region` / `theatre`  the selector for the chosen level
 *  - `renewalWindowMonths`  0 | 1 | 3 | 6 | 12 (default 3; 0 = no overlay)
 *  - `planForWindow`  true to size gaps from the projected end-of-window count
 *  - `companyId`  narrow to one of the key's companies (consumed by the guard)
 *
 * Note this static segment sits beside the `programs/[programName]` dynamic one
 * and wins over it, so a program literally named "planning" is unreachable on
 * this surface — exactly as it already is internally, where the same two
 * segments are siblings. Mirrored deliberately: the public docs then read the
 * same as the internal ones.
 */
export async function GET(request: NextRequest) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;

  const p = request.nextUrl.searchParams;
  const scope = scopeKey(ctx.companyIds);

  // ── Selector-metadata mode ──
  // Registry data, not tenant data: Program/ProgramData/ProgramTier/
  // Specialisation carry no `companyId`, and nothing read here derives from a
  // student, completion or count. That is the same reasoning reviewed and
  // written out at length in `src/app/api/public/v1/programs/route.ts`, and it
  // carries the same trigger: if `Program` ever gains a `companyId`, this
  // branch becomes tenant data and MUST be filtered by `ctx.companyIds`.
  // The scope is in the cache key regardless, so that day brings a filter to
  // add rather than a shared-key leak to discover.
  if (p.get("options") === "true") {
    const options = await cachedReport(
      `public-compliance-planning-options|${scope}`,
      () => buildPlanningOptions(),
    );
    return NextResponse.json({ programs: options }, { headers: { "Cache-Control": "private, max-age=30" } });
  }

  const req = parsePlanRequest(p);
  if (req === null) {
    return NextResponse.json({ error: "Invalid targets" }, { status: 400 });
  }

  // Fail closed on an empty company scope, and on a request that names no
  // target. Both answer with the empty plan run through the same projection the
  // populated case uses — a hand-written empty literal is how a field comes to
  // be present in one branch and missing in the other.
  if (ctx.companyIds.length === 0) {
    return NextResponse.json(toPublicCompliancePlan(emptyCompliancePlan(0)));
  }
  if (req.targets.length === 0) {
    return NextResponse.json(toPublicCompliancePlan(emptyCompliancePlan(req.renewalWindowMonths)));
  }

  // The cache stores the ALREADY-PROJECTED payload, under a `public-` prefix
  // distinct from the internal route's key. Both halves of that matter. A
  // shared key would mean one entry whose stored shape depends on which surface
  // populated it, so a public request winning the race would strip
  // `candidates`/`eligible`/`renewals` from the admin page for the rest of the
  // TTL — it would render an empty "Who to certify" table with no error. And
  // projecting before storing means no entry reachable from this surface ever
  // holds an email, so a future bug that echoed a cache entry cannot leak names
  // through this key. The cost is one extra computation per TTL window when
  // both surfaces happen to ask the same question.
  const result = await cachedReport(
    `public-compliance-planning|${scope}|${planCacheKeyParts(req)}`,
    async () =>
      toPublicCompliancePlan(
        await computeCompliancePlan({
          targets: req.targets,
          level: req.level,
          country: req.country,
          region: req.region,
          theatre: req.theatre,
          companyIds: ctx.companyIds,
          renewalWindowMonths: req.renewalWindowMonths,
          planForWindow: req.planForWindow,
        }),
      ),
  );

  return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
}
