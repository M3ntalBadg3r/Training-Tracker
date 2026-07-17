import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import { computeLastTwelveMonths, type RangePreset } from "@/lib/last-12-months-report";
import type { GroupByMode } from "@/lib/group-by";

/**
 * Achievement Over Time report. Server-side aggregation + pagination so the
 * browser downloads a small summary (time-series chart + Top-10 + KPIs + group
 * subtotals) plus one page of detail rows instead of the whole training-records
 * dataset.
 *
 * Query params: companyId, q (search), type, theatre, region, country, function,
 * product, bucket, range (12m|6m|3m|1m|custom), customFrom, customTo (ISO),
 * groupBy (theatre|region|country), sort, sortDir, page, pageSize, all (export).
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
      charts: { chartData: [], topTitles: [], granularity: "month" },
      kpis: { total: 0, cert: 0, accred: 0, ilt: 0, olx: 0, thisPeriodTotal: 0, priorPeriodTotal: 0, change: 0 },
      groups: [],
      rows: [],
      total: 0,
      page: 1,
      pageSize: 25,
      filterOptions: { types: [], functions: [], products: [] },
    });
  }

  const p = request.nextUrl.searchParams;
  const search = p.get("q") || "";
  const type = p.get("type") || "";
  const theatre = p.get("theatre") || "";
  const region = p.get("region") || "";
  const country = p.get("country") || "";
  const fn = p.get("function") || "";
  const product = p.get("product") || "";
  const bucket = p.get("bucket") || "";
  const rawRange = p.get("range") || "12m";
  const rangePreset: RangePreset =
    rawRange === "12m" || rawRange === "6m" || rawRange === "3m" || rawRange === "1m" || rawRange === "custom"
      ? rawRange
      : "12m";
  const customFrom = p.get("customFrom") || "";
  const customTo = p.get("customTo") || "";
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
    "last-12-months",
    scopeKey(companyFilter),
    encodeURIComponent(search),
    type,
    theatre,
    region,
    country,
    encodeURIComponent(fn),
    encodeURIComponent(product),
    bucket,
    rangePreset,
    customFrom,
    customTo,
    groupBy ?? "",
    sortColumn,
    sortDir,
    all ? "all" : `${page}:${pageSize}`,
  ].join("|");

  const result = await cachedReport(key, () =>
    computeLastTwelveMonths({
      companyIds: companyFilter,
      search,
      type,
      theatre,
      region,
      country,
      function: fn,
      product,
      bucket: bucket || null,
      rangePreset,
      customFrom: customFrom || null,
      customTo: customTo || null,
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
