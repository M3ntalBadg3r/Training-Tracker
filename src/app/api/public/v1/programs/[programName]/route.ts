import { NextRequest, NextResponse } from "next/server";
import { authorizePublicRequest } from "@/lib/public-api";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import { safeDecodeParam } from "@/lib/utils";
import { buildProgramReport, getProgramStudents } from "@/lib/program-report";
import { COUNTRY_SET_SCOPE_ERROR, singleCompanyId } from "@/lib/country-sets";

/**
 * GET /api/public/v1/programs/{programName} — read-only per-program compliance,
 * the API-key counterpart of the internal `/api/programs/[programName]` route.
 * Shares all compliance logic via `lib/program-report.ts`; the only difference
 * is company scope comes from the API key (always a concrete company list) via
 * `authorizePublicRequest`.
 *
 * Query params (same as the internal route):
 *  - `level`   country (default) | region | countrySet | theatre | global
 *  - `country` / `region` / `countrySet` / `theatre`  the selector for the chosen level
 *    (`level=countrySet` needs the request narrowed to exactly one company —
 *    a Country Set belongs to one company — else 400)
 *  - `horizonMonths`  3 | 6 | 12 — forward-looking projection of upcoming expiries
 *  - `trainingTitle` + `students=true`  roster drill-down (comma-separated titles)
 *  - `companyId`  narrow to one of the key's companies (consumed by the guard)
 *
 * Both modes are cached for the same 30s window as the internal twin. This is
 * the most expensive read on the public surface — `buildProgramReport` issues
 * roughly 6-12 queries plus heavy set-union aggregation, doubled when a horizon
 * is requested — and a key may send 120 requests a minute.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ programName: string }> }
) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;

  const { programName: rawName } = await params;
  const programName = safeDecodeParam(rawName);
  if (programName === null) {
    return NextResponse.json({ error: "Invalid program name" }, { status: 400 });
  }

  const sp = request.nextUrl.searchParams;
  const level = sp.get("level") || "country";
  const country = sp.get("country") || "";
  const theatre = sp.get("theatre") || "";
  const region = sp.get("region") || "";
  const countrySet = sp.get("countrySet") || "";
  const trainingTitleParam = sp.get("trainingTitle") || "";
  const studentsMode = sp.get("students") === "true";

  const rawHorizon = parseInt(sp.get("horizonMonths") || "0", 10);
  const horizonMonths = [3, 6, 12].includes(rawHorizon) ? rawHorizon : 0;

  // A key with no accessible companies gets an empty payload (fail closed),
  // matching the internal route's out-of-scope response.
  if (ctx.companyIds.length === 0) {
    if (studentsMode) return NextResponse.json({ students: [] });
    return NextResponse.json({
      specialisations: [],
      countries: [],
      regions: [],
      countrySets: [],
      theatres: [],
      meta: { levels: [], hasMinimumPerTheatre: false },
      horizonMonths: 0,
    });
  }

  // A Country Set belongs to one company and its name resolves only within it,
  // so a countrySet report or roster needs the request narrowed to exactly one
  // company — `?companyId=` (already intersected with the key's grant by the
  // guard), or a key granted a single company. Otherwise two partners'
  // same-named sets would be ambiguous; refuse with a 400 rather than answer
  // with an empty area that reads as an honest zero. Naming the rule discloses
  // nothing: it depends only on the key's own grant, never on the DB.
  if (level === "countrySet" && singleCompanyId(ctx.companyIds) === null) {
    return NextResponse.json({ error: COUNTRY_SET_SCOPE_ERROR }, { status: 400 });
  }

  // Every free-text fragment is percent-encoded so a literal "|" in a program
  // name, training title or country can't collide with the key delimiter and
  // cross two views onto one entry. The keys carry a `public-` prefix, distinct
  // from the internal twin's, for the reason set out on the planning route: the
  // two surfaces return the same shape *today*, so a shared key would be
  // correct and would even save a computation — but it would silently couple
  // them, and the planning route is the worked example of what happens when one
  // surface later starts projecting its payload.
  const scope = scopeKey(ctx.companyIds);
  const progKey = encodeURIComponent(programName);
  const geoKey =
    `${encodeURIComponent(level)}|${encodeURIComponent(country)}|${encodeURIComponent(region)}|` +
    `${encodeURIComponent(countrySet)}|${encodeURIComponent(theatre)}`;

  if (studentsMode && trainingTitleParam) {
    const titles = trainingTitleParam.split(",").map((t) => t.trim()).filter(Boolean);
    const result = await cachedReport(
      `public-program-students|${progKey}|${scope}|${geoKey}|${encodeURIComponent(trainingTitleParam)}`,
      () =>
        getProgramStudents({
          trainingTitles: titles, level, country, region, countrySet, theatre, companyIds: ctx.companyIds,
        }),
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
  }

  const report = await cachedReport(
    `public-program|${progKey}|${scope}|${geoKey}|${horizonMonths}`,
    () =>
      buildProgramReport({
        programName, level, country, region, countrySet, theatre, horizonMonths, companyIds: ctx.companyIds,
      }),
  );
  return NextResponse.json(report, { headers: { "Cache-Control": "private, max-age=30" } });
}
