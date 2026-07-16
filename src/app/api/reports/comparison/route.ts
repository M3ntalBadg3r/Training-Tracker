import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import { computeComparison, type CompareMode, type RangePreset } from "@/lib/comparison-report";
import type { GroupByMode } from "@/lib/group-by";

/**
 * Theatre / Region / Country Comparison. Server-side aggregation so the browser
 * downloads only the small per-geography matrix + chart instead of the whole
 * training-records + students datasets. The result is one row per geography
 * bucket (no pagination); the client sorts it.
 *
 * Query params: companyId, geoMode (theatre|region|country), range (12m|6m|3m|
 * all|custom), from, to (yyyy-mm-dd for custom), func, product, type, compareMode
 * (type|function|product|time).
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
      metrics: [],
      totals: { headcount: 0, cert: 0, accred: 0, ilt: 0, olx: 0, total: 0, exp3: 0, exp6: 0 },
      chart: { mode: "type", rows: [], series: [] },
      filterOptions: { functions: [], products: [], types: [] },
    });
  }

  const p = request.nextUrl.searchParams;
  const geoRaw = p.get("geoMode") || "theatre";
  const geoMode: GroupByMode = geoRaw === "region" || geoRaw === "country" ? geoRaw : "theatre";
  const rangeRaw = p.get("range") || "12m";
  const rangePreset: RangePreset = (["12m", "6m", "3m", "all", "custom"] as string[]).includes(rangeRaw)
    ? (rangeRaw as RangePreset)
    : "12m";
  const customFrom = p.get("from") || null;
  const customTo = p.get("to") || null;
  const filterFunction = p.get("func") || "";
  const filterProduct = p.get("product") || "";
  const filterType = p.get("type") || "";
  const cmRaw = p.get("compareMode") || "type";
  const compareMode: CompareMode = (["type", "function", "product", "time"] as string[]).includes(cmRaw)
    ? (cmRaw as CompareMode)
    : "type";

  const key = [
    "comparison",
    scopeKey(companyFilter),
    geoMode,
    rangePreset,
    customFrom ?? "",
    customTo ?? "",
    encodeURIComponent(filterFunction),
    encodeURIComponent(filterProduct),
    encodeURIComponent(filterType),
    compareMode,
  ].join("|");

  const result = await cachedReport(key, () =>
    computeComparison({
      companyIds: companyFilter,
      geoMode,
      rangePreset,
      customFrom,
      customTo,
      filterFunction,
      filterProduct,
      filterType,
      compareMode,
    })
  );

  return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
}
