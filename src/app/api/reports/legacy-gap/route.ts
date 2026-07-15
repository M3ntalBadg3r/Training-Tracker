import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { computeLegacyGaps } from "@/lib/legacy-gap";
import { cachedReport, scopeKey } from "@/lib/report-cache";

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) return NextResponse.json([]);

  // companyFilter === null means "all companies" (SuperAdmin); otherwise the
  // intersection of the caller's allowed companies and any ?companyId= filter.
  const rows = await cachedReport(
    `legacy-gap|${scopeKey(companyFilter)}`,
    () => computeLegacyGaps(companyFilter),
  );
  return NextResponse.json(rows, { headers: { "Cache-Control": "private, max-age=30" } });
}
