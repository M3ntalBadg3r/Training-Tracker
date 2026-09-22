import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import {
  computeRenewalForecast,
  renewalForecastScopeLabel,
} from "@/lib/renewal-forecast";

/**
 * Renewal forecast — a 12-month renewed-vs-lapsed projection.
 *
 * A thin wrapper: this route resolves the caller's company scope from their
 * session and delegates to `lib/renewal-forecast.ts`, which the public API-key
 * route shares, so the two surfaces cannot drift.
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

  // Geographic scope (narrowest wins: country → region → theatre).
  const countryParam = request.nextUrl.searchParams.get("country") || "";
  const regionParam = request.nextUrl.searchParams.get("region") || "";
  const theatreParam = request.nextUrl.searchParams.get("theatre") || "";
  const scopeLabel = renewalForecastScopeLabel(countryParam, regionParam, theatreParam);

  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({ monthly: [], titleRows: [], globalRate: 0, historicalRenewed: 0, historicalLapsed: 0, scopeLabel });
  }

  const body = await cachedReport(
    `renewal-forecast|${scopeKey(companyFilter)}|${theatreParam}|${regionParam}|${countryParam}`,
    () => computeRenewalForecast(companyFilter, countryParam, regionParam, theatreParam),
  );

  return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=30" } });
}
