import { NextRequest, NextResponse } from "next/server";
import { authorizePublicRequest } from "@/lib/public-api";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import { fetchTrainingsWithStudents } from "@/lib/report-queries";

/**
 * GET /api/public/v1/training-records — per-completion training records (latest
 * per learner + training) scoped to the API key's companies. Optional filters:
 * `?companyId=`, `?theatre=`, `?region=`, `?country=`, `?activeOnly=true`.
 *
 * Cached for 30s like the internal `/api/reports/training-records`, which runs
 * the same wide join + dedupe.
 */
export async function GET(request: NextRequest) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.companyIds.length === 0) return NextResponse.json([]);

  const params = request.nextUrl.searchParams;
  // Read once, then use the same values for the key and the query, so the two
  // can never describe different views.
  const theatre = params.get("theatre");
  const region = params.get("region");
  const country = params.get("country");
  const activeOnly = params.get("activeOnly") === "true";

  // Deliberately NOT a copy of the internal twin's key, which is just
  // `training-records|<scope>`: that route takes no filters, while this one
  // takes four. Dropping them would collapse every filter combination onto one
  // entry and serve the wrong rows, so the extra fragments are load-bearing
  // rather than noise. `?? ""` matters too — an absent filter reads as `null`,
  // and null and "" must land on one fragment rather than two.
  const key = [
    "public-training-records",
    scopeKey(ctx.companyIds),
    encodeURIComponent(theatre ?? ""),
    encodeURIComponent(region ?? ""),
    encodeURIComponent(country ?? ""),
    activeOnly ? "1" : "0",
  ].join("|");

  const records = await cachedReport(key, () =>
    fetchTrainingsWithStudents({ companyIds: ctx.companyIds, theatre, region, country, activeOnly }),
  );

  return NextResponse.json(records, { headers: { "Cache-Control": "private, max-age=30" } });
}
