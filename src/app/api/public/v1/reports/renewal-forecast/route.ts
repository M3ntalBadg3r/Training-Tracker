import { NextRequest, NextResponse } from "next/server";
import { authorizePublicRequest } from "@/lib/public-api";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import {
  computeRenewalForecast,
  renewalForecastScopeLabel,
} from "@/lib/renewal-forecast";

/**
 * GET /api/public/v1/reports/renewal-forecast — a 12-month renewed-vs-lapsed
 * projection with an at-risk-by-training breakdown. The API-key counterpart of
 * the internal `/api/reports/renewal-forecast`; both are thin wrappers over
 * `lib/renewal-forecast.ts`, so the two surfaces cannot drift.
 *
 * No projection is applied, stated rather than left to inference: `monthly[]`
 * is counts per month and `titleRows[]` is fullTitle / productType / counts /
 * rate — training catalogue names, not people. Nothing here identifies anyone.
 *
 * This is a **separate endpoint, not a value for `/reports/{reportType}`** — it
 * is not in that route's `VALID_REPORT_TYPES`. The static segment sits beside
 * the dynamic `[reportType]` one and wins over it, which is what makes this
 * path resolve here.
 *
 * Query params: `?country=`/`?region=`/`?theatre=` scope the population
 * (narrowest wins); `?companyId=` narrows to one of the key's companies
 * (consumed by the guard).
 */
export async function GET(request: NextRequest) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;

  const p = request.nextUrl.searchParams;
  const countryParam = p.get("country") || "";
  const regionParam = p.get("region") || "";
  const theatreParam = p.get("theatre") || "";
  const scopeLabel = renewalForecastScopeLabel(countryParam, regionParam, theatreParam);

  // Fail closed: a key with no accessible companies gets the empty payload,
  // matching the internal route's out-of-scope response.
  if (ctx.companyIds.length === 0) {
    return NextResponse.json({ monthly: [], titleRows: [], globalRate: 0, historicalRenewed: 0, historicalLapsed: 0, scopeLabel });
  }

  const body = await cachedReport(
    `public-renewal-forecast|${scopeKey(ctx.companyIds)}|${theatreParam}|${regionParam}|${countryParam}`,
    () => computeRenewalForecast(ctx.companyIds, countryParam, regionParam, theatreParam),
  );

  return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=30" } });
}
