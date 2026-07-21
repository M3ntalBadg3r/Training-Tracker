import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter, canAccessCompany } from "@/lib/company-scope";

/**
 * GET /api/admin/offerings
 * Returns the offering registry (one entry per Offering row) with its selected
 * specialisations and a requirement count, scoped to the companies the caller
 * can access (optionally narrowed by ?companyId=). Data source for the admin
 * card index.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json([]);
  }

  const offerings = await prisma.offering.findMany({
    where: companyFilter ? { companyId: { in: companyFilter } } : {},
    include: {
      company: { select: { name: true } },
      specialisations: { include: { specialisation: { select: { name: true } } } },
      _count: { select: { offeringData: true } },
    },
    orderBy: [{ name: "asc" }],
  });

  const result = offerings.map((o) => ({
    id: o.id,
    companyId: o.companyId,
    companyName: o.company?.name ?? null,
    name: o.name,
    description: o.description ?? null,
    link: o.link ?? null,
    specialisations: o.specialisations
      .map((s) => s.specialisation?.name)
      .filter((n): n is string => !!n)
      .sort(),
    requirementCount: o._count.offeringData,
  }));

  return NextResponse.json(result);
}

/**
 * POST /api/admin/offerings
 * Creates an offering for a company the caller can access.
 * Body: { companyId, name, description?, link?, specialisationIds?[] }.
 */
export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Offering name is required" }, { status: 400 });
  }
  const companyId = body?.companyId == null ? NaN : Number(body.companyId);
  if (Number.isNaN(companyId)) {
    return NextResponse.json({ error: "A company is required" }, { status: 400 });
  }
  if (!(await canAccessCompany(auth.sub, auth.role, companyId))) {
    return NextResponse.json({ error: "You do not have access to that company" }, { status: 403 });
  }
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  const description = typeof body?.description === "string" ? body.description.trim() || null : null;
  const link = typeof body?.link === "string" ? body.link.trim() || null : null;
  const specialisationIds: number[] = Array.isArray(body?.specialisationIds)
    ? [
        ...new Set(
          (body.specialisationIds as unknown[]).map((n) => Number(n)).filter((n) => !Number.isNaN(n))
        ),
      ]
    : [];

  const existing = await prisma.offering.findUnique({
    where: { companyId_name: { companyId, name } },
  });
  if (existing) {
    return NextResponse.json(
      { error: "An offering with this name already exists for this company" },
      { status: 409 }
    );
  }

  // Validate that every provided specialisation exists.
  if (specialisationIds.length > 0) {
    const found = await prisma.specialisation.count({ where: { id: { in: specialisationIds } } });
    if (found !== specialisationIds.length) {
      return NextResponse.json({ error: "One or more specialisations not found" }, { status: 404 });
    }
  }

  const offering = await prisma.offering.create({
    data: {
      companyId,
      name,
      description,
      link,
      specialisations:
        specialisationIds.length > 0
          ? { create: specialisationIds.map((specialisationId) => ({ specialisationId })) }
          : undefined,
    },
  });

  return NextResponse.json(
    {
      id: offering.id,
      companyId: offering.companyId,
      name: offering.name,
      description: offering.description,
      link: offering.link,
    },
    { status: 201 }
  );
}
