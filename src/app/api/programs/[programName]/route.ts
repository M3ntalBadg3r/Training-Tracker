import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { buildProgramReport, getProgramStudents } from "@/lib/program-report";
import { cachedReport, scopeKey } from "@/lib/report-cache";

/**
 * Unified, data-driven program compliance endpoint. The program is identified
 * by the `[programName]` route segment (URL-decoded), so any program configured
 * in ProgramData gets a dashboard without code changes. This is the union of
 * the old hardcoded APS and Global Diamond routes:
 *  - Country / Region / Theatre levels behave like APS (count attained people).
 *  - The Global level supports both APS "compliant theatre count" semantics and
 *    Global Diamond per-title global counts with optional per-theatre minimums.
 *
 * A `meta` block reports the configured levels and whether any requirement uses
 * a per-theatre minimum, so the client can render the right sections.
 *
 * The compliance calculations themselves live in `lib/program-report.ts`, shared
 * with the public (API-key) route at `/api/public/v1/programs/[programName]`;
 * this handler only resolves the session's company scope and delegates.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ programName: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { programName: rawName } = await params;
  let programName: string;
  try {
    programName = decodeURIComponent(rawName);
  } catch {
    return NextResponse.json({ error: "Invalid program name" }, { status: 400 });
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({
      specialisations: [],
      countries: [],
      regions: [],
      theatres: [],
      meta: { levels: [], hasMinimumPerTheatre: false },
      horizonMonths: 0,
    });
  }

  const level = request.nextUrl.searchParams.get("level") || "country";
  const country = request.nextUrl.searchParams.get("country") || "";
  const theatre = request.nextUrl.searchParams.get("theatre") || "";
  const region = request.nextUrl.searchParams.get("region") || "";
  const trainingTitleParam = request.nextUrl.searchParams.get("trainingTitle") || "";
  const studentsMode = request.nextUrl.searchParams.get("students") === "true";

  // Optional forward-looking projection: recompute compliance as it will stand
  // `horizonMonths` from now, so upcoming certificate expiries surface before
  // they break compliance. Only a fixed set of horizons is accepted.
  const rawHorizon = parseInt(request.nextUrl.searchParams.get("horizonMonths") || "0", 10);
  const horizonMonths = [3, 6, 12].includes(rawHorizon) ? rawHorizon : 0;

  // Encode the free-text program name / training titles so a literal "|" in the
  // value can't collide with the key delimiter and cross views.
  const scope = scopeKey(companyFilter);
  const progKey = encodeURIComponent(programName);

  if (studentsMode && trainingTitleParam) {
    const titles = trainingTitleParam.split(",").map((t) => t.trim()).filter(Boolean);
    const result = await cachedReport(
      `program-students|${progKey}|${scope}|${level}|${country}|${region}|${theatre}|${encodeURIComponent(trainingTitleParam)}`,
      () => getProgramStudents({ trainingTitles: titles, level, country, region, theatre, companyIds: companyFilter }),
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
  }

  const report = await cachedReport(
    `program|${progKey}|${scope}|${level}|${country}|${region}|${theatre}|${horizonMonths}`,
    () => buildProgramReport({ programName, level, country, region, theatre, horizonMonths, companyIds: companyFilter }),
  );
  return NextResponse.json(report, { headers: { "Cache-Control": "private, max-age=30" } });
}
