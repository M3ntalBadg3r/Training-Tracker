import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { fetchTrainingsWithStudents } from "@/lib/report-queries";

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { searchParams } = request.nextUrl;
  const theatre = searchParams.get("theatre");
  const region = searchParams.get("region");
  const country = searchParams.get("country");
  const activeOnly = searchParams.get("active") === "true";

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json([]);
  }

  const rows = await fetchTrainingsWithStudents({
    companyIds: companyFilter,
    theatre,
    region,
    country,
    activeOnly,
  });

  return NextResponse.json(rows);
}
