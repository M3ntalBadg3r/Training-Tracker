import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";

/**
 * GET /api/offerings
 * Lists offerings for the index page + sidebar, scoped to the companies the
 * caller can access (optionally narrowed by ?companyId=). Offerings are tenant
 * data, so a user only sees the offerings of companies they're granted.
 */
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
    return NextResponse.json({ offerings: [] });
  }

  const offerings = await prisma.offering.findMany({
    where: companyFilter ? { companyId: { in: companyFilter } } : {},
    include: {
      company: { select: { name: true } },
      _count: { select: { specialisations: true, offeringData: true } },
    },
    orderBy: { name: "asc" },
  });

  const result = offerings.map((o) => ({
    name: o.name,
    companyId: o.companyId,
    // Named so the index can label a card with its company under "All companies";
    // only ever a company the caller is already scoped to.
    companyName: o.company?.name ?? null,
    description: o.description ?? null,
    link: o.link ?? null,
    specialisationCount: o._count.specialisations,
    requirementCount: o._count.offeringData,
  }));

  return NextResponse.json({ offerings: result });
}
