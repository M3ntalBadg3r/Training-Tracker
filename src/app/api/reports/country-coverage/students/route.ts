import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import {
  computeCountryCoverageDrilldown,
  parseCoverageFunction,
  parseCoverageMetric,
  parseCoverageTypeFilter,
  sortDrilldown,
} from "@/lib/country-coverage-report";

const PAGE_SIZES = [25, 50, 100, 250];

/**
 * The people or completions behind one figure of the Country Coverage report.
 * Takes the report's own filters plus the clicked cell's scope (`country`, or
 * `theatre` / `noTheatre` for a subtotal), `metric` (headcount|people|held) and
 * `fn` (Sales|PreSales|Deployments, or omitted for the Total/Any columns).
 * Built from the same inputs and counting rule as the report, so the list
 * length is the figure that was clicked. Sorted and paged here (`sort`,
 * `sortDir`, `page`, `size`); `all=true` returns every row for export.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const p = request.nextUrl.searchParams;
  const metric = parseCoverageMetric(p.get("metric"));
  if (!metric) return NextResponse.json({ error: "Unknown metric" }, { status: 400 });
  const fn = parseCoverageFunction(p.get("fn"));

  const sizeRaw = Number(p.get("size"));
  const pageSize = PAGE_SIZES.includes(sizeRaw) ? sizeRaw : 50;
  const pageRaw = Number(p.get("page"));
  const requestedPage = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const all = p.get("all") === "true";
  const sortDir = p.get("sortDir") === "desc" ? "desc" : "asc";
  const sortKey = p.get("sort") || "fullName";

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, p.get("companyId"));
  const kind = metric === "held" ? "records" : "students";
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({ kind, rows: [], total: 0, page: 1, pageSize });
  }

  const noTheatre = p.get("noTheatre") === "true";
  const theatre = noTheatre ? "" : p.get("theatre") || "";
  const region = p.get("region") || "";
  const country = p.get("country") || "";
  const type = parseCoverageTypeFilter(p.get("type"));
  const includeInactive = p.get("includeInactive") === "true";

  const key = [
    "country-coverage-students",
    scopeKey(companyFilter),
    encodeURIComponent(theatre),
    noTheatre ? "1" : "0",
    encodeURIComponent(region),
    encodeURIComponent(country),
    type,
    includeInactive ? "1" : "0",
    metric,
    fn,
  ].join("|");

  const data = await cachedReport(key, () =>
    computeCountryCoverageDrilldown({
      companyIds: companyFilter,
      theatre,
      noTheatre,
      region,
      country,
      type,
      includeInactive,
      metric,
      fn,
    })
  );

  const sorted = sortDrilldown(data, sortKey, sortDir);
  const total = sorted.length;
  if (all) {
    return NextResponse.json({ kind: data.kind, rows: sorted, total, page: 1, pageSize: total });
  }
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, lastPage);
  return NextResponse.json(
    { kind: data.kind, rows: sorted.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize },
    { headers: { "Cache-Control": "private, max-age=30" } },
  );
}
