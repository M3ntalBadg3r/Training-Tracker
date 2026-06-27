import { NextRequest, NextResponse } from "next/server";
import { authorizePublicRequest } from "@/lib/public-api";
import { fetchReportData, type ReportType } from "@/lib/report-queries";

// The report types exposed over the public API (mirrors lib/report-queries.ts).
const VALID_REPORT_TYPES = new Set<ReportType>([
  "trained-not-certified",
  "legacy-gap",
  "learner-scorecard",
  "by-product",
  "by-function",
  "expiring-soon",
  "currently-expired",
  "last-12-months",
]);

/**
 * GET /api/public/v1/reports/[reportType] — pre-built report aggregates scoped
 * to the API key's companies. Optional `?companyId=` narrows to one company.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reportType: string }> }
) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;

  const { reportType } = await params;
  if (!VALID_REPORT_TYPES.has(reportType as ReportType)) {
    return NextResponse.json(
      {
        error: "Unknown report type",
        validReportTypes: Array.from(VALID_REPORT_TYPES),
      },
      { status: 404 }
    );
  }

  if (ctx.companyIds.length === 0) {
    return NextResponse.json({ reportType, title: "", data: [] });
  }

  const result = await fetchReportData(reportType as ReportType, ctx.companyIds);
  return NextResponse.json({
    reportType,
    title: result.title,
    data: result.data,
  });
}
