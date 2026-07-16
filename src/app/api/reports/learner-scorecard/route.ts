import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import { computeLearnerScorecard, type ScorecardSortKey } from "@/lib/learner-scorecard";

const SORT_KEYS: ScorecardSortKey[] = [
  "fullName", "cert", "accred", "ilt", "olx", "total", "expiring", "lapsed", "gaps", "lastDate",
];

/**
 * Learner Achievement Scorecard. Server-side per-learner rollup + pagination so
 * the browser downloads a small summary (KPIs + leaderboard) plus one page of
 * rows instead of three full datasets.
 *
 * Query params: companyId, q, theatre, region, country, windowMonths (1|3|6),
 * includeExpired, sort, sortDir, page, pageSize, all (export).
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
      kpis: { learners: 0, achievements: 0, withGaps: 0, withExpiring: 0, zero: 0 },
      leaderboard: [],
      rows: [],
      total: 0,
      page: 1,
      pageSize: 25,
      filterOptions: { theatres: [], regions: [], countries: [] },
    });
  }

  const p = request.nextUrl.searchParams;
  const search = p.get("q") || "";
  const theatre = p.get("theatre") || "";
  const region = p.get("region") || "";
  const country = p.get("country") || "";
  const windowRaw = parseInt(p.get("windowMonths") || "6", 10);
  const windowMonths = [1, 3, 6].includes(windowRaw) ? windowRaw : 6;
  const includeExpired = p.get("includeExpired") === "true";
  const sortRaw = p.get("sort") || "total";
  const sortKey: ScorecardSortKey = (SORT_KEYS as string[]).includes(sortRaw) ? (sortRaw as ScorecardSortKey) : "total";
  const sortDir = p.get("sortDir") === "asc" ? "asc" : "desc";
  const all = p.get("all") === "true";
  const page = Math.max(1, parseInt(p.get("page") || "1", 10) || 1);
  const pageSizeRaw = parseInt(p.get("pageSize") || "25", 10) || 25;
  const pageSize = Math.min(200, Math.max(1, pageSizeRaw));

  const key = [
    "learner-scorecard",
    scopeKey(companyFilter),
    encodeURIComponent(search),
    theatre,
    region,
    country,
    windowMonths,
    includeExpired ? "1" : "0",
    sortKey,
    sortDir,
    all ? "all" : `${page}:${pageSize}`,
  ].join("|");

  const result = await cachedReport(key, () =>
    computeLearnerScorecard({
      companyIds: companyFilter,
      search,
      theatre,
      region,
      country,
      windowMonths,
      includeExpired,
      sortKey,
      sortDir,
      page,
      pageSize,
      all,
    })
  );

  return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
}
