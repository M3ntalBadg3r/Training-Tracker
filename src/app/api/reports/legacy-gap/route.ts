import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { computeLegacyGapReport } from "@/lib/legacy-gap-report";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import type { GroupByMode } from "@/lib/group-by";

/**
 * Legacy Replacement Gap report. Server-side aggregation + pagination so the
 * browser downloads a small summary (charts + KPIs + group subtotals) plus one
 * page of detail rows instead of the whole gap dataset.
 *
 * Query params: companyId, q (search), window (all|expired|1|3|6|12), type,
 * product, theatre, region, country, horizon, includeNoReplacement,
 * requireActive, groupBy (theatre|region|country), sort, sortDir, page, pageSize,
 * all (export).
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
    return NextResponse.json({
      charts: { horizonSeries: [], productSeries: [] },
      kpis: { total: 0, expired: 0, soon: 0, noReplacement: 0 },
      groups: [],
      rows: [],
      total: 0,
      page: 1,
      pageSize: 25,
      filterOptions: { products: [] },
    });
  }

  const p = request.nextUrl.searchParams;
  const search = p.get("q") || "";
  const window = p.get("window") || "all";
  const type = p.get("type") || "";
  const product = p.get("product") || "";
  const theatre = p.get("theatre") || "";
  const region = p.get("region") || "";
  const country = p.get("country") || "";
  const horizon = p.get("horizon") || "";
  // Both toggles default ON — the client always sends them, but be explicit.
  const includeNoReplacement = p.get("includeNoReplacement") !== "false";
  const requireActive = p.get("requireActive") !== "false";
  const rawGroupBy = p.get("groupBy") || "";
  const groupBy: GroupByMode | null =
    rawGroupBy === "theatre" || rawGroupBy === "region" || rawGroupBy === "country" ? rawGroupBy : null;
  const sortColumn = p.get("sort") || "fullName";
  const sortDir = p.get("sortDir") === "desc" ? "desc" : "asc";
  const all = p.get("all") === "true";
  const page = Math.max(1, parseInt(p.get("page") || "1", 10) || 1);
  const pageSizeRaw = parseInt(p.get("pageSize") || "25", 10) || 25;
  const pageSize = Math.min(200, Math.max(1, pageSizeRaw));

  const key = [
    "legacy-gap",
    scopeKey(companyFilter),
    encodeURIComponent(search),
    window,
    type,
    encodeURIComponent(product),
    theatre,
    region,
    country,
    horizon,
    includeNoReplacement ? "1" : "0",
    requireActive ? "1" : "0",
    groupBy ?? "",
    sortColumn,
    sortDir,
    all ? "all" : `${page}:${pageSize}`,
  ].join("|");

  const result = await cachedReport(key, () =>
    computeLegacyGapReport({
      companyIds: companyFilter,
      search,
      window,
      type,
      product,
      theatre,
      region,
      country,
      horizon: horizon || null,
      includeNoReplacement,
      requireActive,
      groupBy,
      sortColumn,
      sortDir,
      page,
      pageSize,
      all,
    })
  );

  return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
}
