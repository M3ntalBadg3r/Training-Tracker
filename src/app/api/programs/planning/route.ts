import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import { buildPlanningOptions } from "@/lib/planning-options";
import { COUNTRY_SET_SCOPE_ERROR, listCountrySetNames, singleCompanyId } from "@/lib/country-sets";
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
 *    without one detail fetch per program, plus `countrySets` — the names a
 *    "By Country Set" scope can pick from: the scoped company's own sets, empty
 *    unless the scope is exactly one company (sets are per-company tenant data).
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

  const optionsMode = p.get("options") === "true";

  // Fail closed on empty company scope (before the cache), like the reports.
  // This runs before BOTH modes: the selector metadata carries tenant data too
  // (`countrySets`), so it may not be answered ahead of the scope check. The
  // program registry half is global and is still returned — a caller who may
  // read no company can see which programs exist, exactly as before.
  if (companyFilter !== null && companyFilter.length === 0) {
    if (optionsMode) {
      return NextResponse.json({ programs: await buildPlanningOptions(), countrySets: [] as string[] });
    }
    return NextResponse.json(emptyCompliancePlan(0));
  }

  // ── Selector-metadata mode ──
  // `programs` is the global registry (Program/ProgramData/ProgramTier carry no
  // companyId). `countrySets` is per-company tenant data: the scoped company's
  // own non-empty sets, and `[]` unless the scope is exactly one company
  // (`listCountrySetNames` enforces that), so a multi-company or unrestricted
  // scope never lists set names and no other tenant's names can leak here. The
  // scope is in the cache key, which that makes load-bearing.
  if (optionsMode) {
    const options = await cachedReport(
      // "-v2": the value became `{programs, countrySets}` (it was the bare
      // programs array), so no entry of the old shape can ever be served.
      `compliance-planning-options-v2|${scopeKey(companyFilter)}`,
      async () => {
        const [programs, countrySets] = await Promise.all([buildPlanningOptions(), listCountrySetNames(companyFilter)]);
        return { programs, countrySets };
      },
    );
    return NextResponse.json(options, { headers: { "Cache-Control": "private, max-age=30" } });
  }

  // Parsing and clamping are shared with the public API-key route so the two
  // surfaces cannot diverge on what they accept (see lib/compliance-plan-request.ts).
  const req = parsePlanRequest(p);
  if (req === null) {
    return NextResponse.json({ error: "Invalid targets" }, { status: 400 });
  }

  // A Country Set name resolves only within one company (sets are per-company
  // tenant data), so a countrySet plan over any other scope is refused rather
  // than planned against an empty area. The page always sends one company.
  if (req.level === "countrySet" && singleCompanyId(companyFilter) === null) {
    return NextResponse.json({ error: COUNTRY_SET_SCOPE_ERROR }, { status: 400 });
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
        countrySet: req.countrySet,
        theatre: req.theatre,
        companyIds: companyFilter,
        renewalWindowMonths: req.renewalWindowMonths,
        planForWindow: req.planForWindow,
      }),
  );

  return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
}
