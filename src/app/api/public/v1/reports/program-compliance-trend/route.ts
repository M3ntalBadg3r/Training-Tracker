import { NextRequest, NextResponse } from "next/server";
import { authorizePublicRequest } from "@/lib/public-api";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import {
  computeComplianceTrend,
  TREND_DEFAULT_SCOPE_LABEL,
} from "@/lib/program-compliance-trend";

/**
 * GET /api/public/v1/reports/program-compliance-trend — 12 months of
 * point-in-time compliance history plus a 12-month expiry-driven forecast, per
 * (program, specialisation). The API-key counterpart of the internal
 * `/api/reports/program-compliance-trend`; both are thin wrappers over
 * `lib/program-compliance-trend.ts`, so the two surfaces cannot drift.
 *
 * No projection is applied, and that is a claim worth stating rather than
 * leaving a reviewer to infer from its absence: the payload is
 * `{snapshots, programs, specialisations, scopeLabel}`, and a snapshot row is
 * (program, specialisation, month, attained, required, pct, projected) — names
 * of programs, specialisations and months, and counts. No email, no person name,
 * at any depth.
 *
 * This is a **separate endpoint, not a value for `/reports/{reportType}`** — it
 * is not in that route's `VALID_REPORT_TYPES`. The static segment sits beside
 * the dynamic `[reportType]` one and wins over it, which is what makes this
 * path resolve here.
 *
 * Query params: `?program=` narrows to one program; `?country=`/`?region=`/
 * `?theatre=` scope the population (narrowest wins); `?companyId=` narrows to
 * one of the key's companies (consumed by the guard).
 */
export async function GET(request: NextRequest) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;

  const p = request.nextUrl.searchParams;
  const programFilter = p.get("program");
  const countryParam = p.get("country") || "";
  const regionParam = p.get("region") || "";
  const theatreParam = p.get("theatre") || "";

  // Fail closed: a key with no accessible companies gets the empty payload,
  // matching the internal route's out-of-scope response.
  if (ctx.companyIds.length === 0) {
    return NextResponse.json({ snapshots: [], programs: [], specialisations: [], scopeLabel: TREND_DEFAULT_SCOPE_LABEL });
  }

  const body = await cachedReport(
    `public-pct|${scopeKey(ctx.companyIds)}|${programFilter || ""}|${theatreParam}|${regionParam}|${countryParam}`,
    () => computeComplianceTrend(ctx.companyIds, programFilter, countryParam, regionParam, theatreParam),
  );

  return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=30" } });
}
