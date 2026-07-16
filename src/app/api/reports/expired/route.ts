import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import { computeExpiredReport } from "@/lib/expired-report";
import type { GroupByMode } from "@/lib/group-by";

/**
 * Currently Expired report. Server-side aggregation + pagination so the browser
 * downloads a small summary (charts + KPIs + group subtotals) plus one page of
 * detail rows instead of the whole training-records dataset.
 *
 * Query params: companyId, search (q), type, theatre, region, country, bucket,
 * excludeRetired, groupBy (theatre|region|country), sort, sortDir, page,
 * pageSize, all (export).
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
      charts: { bucketSeries: [], theatreSeries: [] },
      kpis: { total: 0, m1: 0, m3: 0, longOverdue: 0 },
      groups: [],
      rows: [],
      total: 0,
      page: 1,
      pageSize: 25,
      filterOptions: { types: [], theatres: [], regions: [], countries: [] },
    });
  }

  const p = request.nextUrl.searchParams;
  const search = p.get("q") || "";
  const type = p.get("type") || "";
  const theatre = p.get("theatre") || "";
  const region = p.get("region") || "";
  const country = p.get("country") || "";
  const bucket = p.get("bucket") || "";
  const excludeRetired = p.get("excludeRetired") === "true";
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
    "expired",
    scopeKey(companyFilter),
    encodeURIComponent(search),
    type,
    theatre,
    region,
    country,
    bucket,
    excludeRetired ? "1" : "0",
    groupBy ?? "",
    sortColumn,
    sortDir,
    all ? "all" : `${page}:${pageSize}`,
  ].join("|");

  const result = await cachedReport(key, () =>
    computeExpiredReport({
      companyIds: companyFilter,
      search,
      type,
      theatre,
      region,
      country,
      bucket: bucket || null,
      excludeRetired,
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
