import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import {
  computeCountryCoverage,
  emptyCountryCoverage,
  parseCoverageTypeFilter,
} from "@/lib/country-coverage-report";

/**
 * Country Coverage by Function. One row per country in the selected geography
 * (every Region Data country, including ones with no students), with
 * certification/accreditation counts and distinct holders split by function,
 * plus headcount and coverage %. Small enough to return whole — no pagination;
 * the client sorts it.
 *
 * Query params: companyId, theatre, region, country, type (all|cert|accred),
 * includeInactive (true = also count expired completions).
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const p = request.nextUrl.searchParams;
  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, p.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json(emptyCountryCoverage());
  }

  const theatre = p.get("theatre") || "";
  const region = p.get("region") || "";
  const country = p.get("country") || "";
  const type = parseCoverageTypeFilter(p.get("type"));
  const includeInactive = p.get("includeInactive") === "true";

  const key = [
    "country-coverage",
    scopeKey(companyFilter),
    encodeURIComponent(theatre),
    encodeURIComponent(region),
    encodeURIComponent(country),
    type,
    includeInactive ? "1" : "0",
  ].join("|");

  const result = await cachedReport(key, () =>
    computeCountryCoverage({ companyIds: companyFilter, theatre, region, country, type, includeInactive })
  );

  return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
}
