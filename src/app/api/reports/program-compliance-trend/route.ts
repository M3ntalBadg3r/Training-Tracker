import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import {
  computeComplianceTrend,
  TREND_DEFAULT_SCOPE_LABEL,
} from "@/lib/program-compliance-trend";

/**
 * Program compliance trend — 12 months of history plus a 12-month forecast.
 *
 * A thin wrapper: this route resolves the caller's company scope from their
 * session and delegates to `lib/program-compliance-trend.ts`, which the public
 * API-key route shares, so the two surfaces cannot drift.
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
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({ snapshots: [], programs: [], specialisations: [], scopeLabel: TREND_DEFAULT_SCOPE_LABEL });
  }

  const programFilter = request.nextUrl.searchParams.get("program");

  // Optional geographic scope (narrowest selection wins: country > region > theatre).
  const countryParam = request.nextUrl.searchParams.get("country") || "";
  const regionParam = request.nextUrl.searchParams.get("region") || "";
  const theatreParam = request.nextUrl.searchParams.get("theatre") || "";

  const body = await cachedReport(
    `pct|${scopeKey(companyFilter)}|${programFilter || ""}|${theatreParam}|${regionParam}|${countryParam}`,
    () => computeComplianceTrend(companyFilter, programFilter, countryParam, regionParam, theatreParam),
  );

  return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=30" } });
}
