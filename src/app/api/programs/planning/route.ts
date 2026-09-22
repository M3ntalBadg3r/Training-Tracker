import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import { buildPlanningOptions } from "@/lib/planning-options";
import { computeCompliancePlan } from "@/lib/compliance-plan";
import {
  parsePlanRequest,
  planCacheKeyParts,
  emptyCompliancePlan,
} from "@/lib/compliance-plan-request";

/**
 * Compliance Planning endpoint — the action layer over program compliance.
 *
 * Two modes:
 *  - `?options=true`  → per-program selector metadata (name, isTiered, levels,
 *    tier names, specialisation names) so the page can build the target selector
 *    without one detail fetch per program.
 *  - default (plan)   → a gap-closing plan for the selected `targets` + scope:
 *    aggregate roadmap, greedy-allocated candidate drill-down, and renewal-at-risk
 *    overlay. Mirrors the report skeleton (auth → company scope → fail-closed empty
 *    response → cachedReport → Cache-Control), and is flushed by the same
 *    `invalidateReportCache()` that program/training/cert writes already call.
 *
 * `targets` is a URL-encoded JSON array:
 *   [{ program, mode: "tier"|"specialisations"|"all", tier?, specialisations?[] }]
 * so mixed selections ("Gold in Program A + all specs in Program B") are one request.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));

  const p = request.nextUrl.searchParams;

  // ── Selector-metadata mode ──
  if (p.get("options") === "true") {
    // The loader below is genuinely company-agnostic — Program/ProgramData/
    // ProgramTier carry no companyId — so a shared key returns the same bytes
    // to everyone today. The scope goes in the key anyway, because this was the
    // single exception to the rule CLAUDE.md states for every cachedReport key,
    // and an exception is exactly what nobody re-examines: the day program data
    // gains a company dimension this key becomes a cross-tenant leak with no
    // compiler error and no reviewer signal to catch it.
    const options = await cachedReport(
      `compliance-planning-options|${scopeKey(companyFilter)}`,
      () => buildPlanningOptions()
    );
    return NextResponse.json({ programs: options }, { headers: { "Cache-Control": "private, max-age=30" } });
  }

  // Fail closed on empty company scope (before the cache), like the reports.
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json(emptyCompliancePlan(0));
  }

  // Parsing and clamping are shared with the public API-key route so the two
  // surfaces cannot diverge on what they accept (see lib/compliance-plan-request.ts).
  const req = parsePlanRequest(p);
  if (req === null) {
    return NextResponse.json({ error: "Invalid targets" }, { status: 400 });
  }

  if (req.targets.length === 0) {
    return NextResponse.json(emptyCompliancePlan(req.renewalWindowMonths));
  }

  const result = await cachedReport(
    `compliance-planning|${scopeKey(companyFilter)}|${planCacheKeyParts(req)}`,
    () =>
      computeCompliancePlan({
        targets: req.targets,
        level: req.level,
        country: req.country,
        region: req.region,
        theatre: req.theatre,
        companyIds: companyFilter,
        renewalWindowMonths: req.renewalWindowMonths,
        planForWindow: req.planForWindow,
      }),
  );

  return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
}
