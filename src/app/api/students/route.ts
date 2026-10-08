import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { invalidateReportCache } from "@/lib/report-cache";
import { listStudents, studentFilterOptions } from "@/lib/students-list";
import { EMPTY_STUDENT_FILTER_OPTIONS, parseStudentListQuery } from "@/lib/students-list-params";

/**
 * The student list, one page at a time. Search, column filters, sort and
 * paging all run in SQL (`lib/students-list.ts`); every parameter is parsed
 * and clamped by `lib/students-list-params.ts`, the module the page uses to
 * build the same query string. `?options=true` answers only the filter
 * dropdown values (`{ filterOptions }`) for the caller's scope.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const searchParams = request.nextUrl.searchParams;
  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, searchParams.get("companyId"));
  const wantsOptions = searchParams.get("options") === "true";
  const query = parseStudentListQuery(searchParams);

  // Fail closed: an empty scope reads no companies. The helpers would match
  // nothing anyway (`in: []`), this just skips the queries.
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json(
      wantsOptions
        ? { filterOptions: EMPTY_STUDENT_FILTER_OPTIONS }
        : { rows: [], total: 0, page: 1, pageSize: query.pageSize }
    );
  }

  if (wantsOptions) {
    return NextResponse.json({ filterOptions: await studentFilterOptions(companyFilter) });
  }

  // The Company column (and so company-name search) is shown only under
  // "All companies", which is exactly when the page sends no `?companyId=`.
  const includeCompanyInSearch = !searchParams.get("companyId");
  return NextResponse.json(await listStudents(query, companyFilter, { includeCompanyInSearch }));
}

export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const body = await request.json();
  // Theatre is intentionally not accepted from the client — it's derived
  // from the country's RegionData entry to keep tenants consistent.
  const { email, fullName, country, companyId } = body;

  if (!email || !fullName || !country || companyId === undefined || companyId === null) {
    return NextResponse.json({ error: "Missing required fields (including company)" }, { status: 400 });
  }

  if (
    typeof email !== "string" ||
    typeof fullName !== "string" ||
    typeof country !== "string"
  ) {
    return NextResponse.json({ error: "Invalid field types" }, { status: 400 });
  }
  if (email.length > 255 || fullName.length > 255 || country.length > 100) {
    return NextResponse.json({ error: "Field value too long" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
  }

  const cid = Number(companyId);
  if (!Number.isInteger(cid)) {
    return NextResponse.json({ error: "Invalid company" }, { status: 400 });
  }

  const allowed = await canAccessCompany(auth.sub, auth.role, cid);
  if (!allowed) {
    return NextResponse.json({ error: "You do not have access to that company" }, { status: 403 });
  }

  const company = await prisma.company.findUnique({ where: { id: cid } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const regionData = await prisma.regionData.findUnique({ where: { country } });
  if (!regionData || !regionData.theatre) {
    return NextResponse.json(
      {
        error: `Country "${country}" must exist in Region Data with a theatre assigned. Ask a SuperAdmin to set it up.`,
      },
      { status: 400 }
    );
  }

  const student = await prisma.student.create({
    data: { email, fullName, theatre: regionData.theatre, country, companyId: cid },
  });

  invalidateReportCache();
  return NextResponse.json(student, { status: 201 });
}
