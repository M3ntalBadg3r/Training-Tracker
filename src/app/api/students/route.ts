import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));

  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json([]);
  }

  const students = await prisma.student.findMany({
    where: companyFilter ? { companyId: { in: companyFilter } } : {},
    include: { regionData: true, company: { select: { id: true, name: true } } },
    orderBy: { fullName: "asc" },
  });

  const result = students.map((s) => ({
    email: s.email,
    fullName: s.fullName,
    theatre: s.theatre,
    country: s.country,
    region: s.regionData?.region || null,
    companyId: s.companyId,
    companyName: s.company?.name ?? null,
  }));

  return NextResponse.json(result);
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

  return NextResponse.json(student, { status: 201 });
}
