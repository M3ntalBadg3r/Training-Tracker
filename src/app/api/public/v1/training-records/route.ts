import { NextRequest, NextResponse } from "next/server";
import { authorizePublicRequest } from "@/lib/public-api";
import { fetchTrainingsWithStudents } from "@/lib/report-queries";

/**
 * GET /api/public/v1/training-records — per-completion training records (latest
 * per learner + training) scoped to the API key's companies. Optional filters:
 * `?companyId=`, `?theatre=`, `?region=`, `?country=`, `?activeOnly=true`.
 */
export async function GET(request: NextRequest) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.companyIds.length === 0) return NextResponse.json([]);

  const params = request.nextUrl.searchParams;
  const records = await fetchTrainingsWithStudents({
    companyIds: ctx.companyIds,
    theatre: params.get("theatre"),
    region: params.get("region"),
    country: params.get("country"),
    activeOnly: params.get("activeOnly") === "true",
  });

  return NextResponse.json(records);
}
