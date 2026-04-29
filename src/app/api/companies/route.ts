import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds } from "@/lib/company-scope";

// GET: companies the caller is allowed to see, used to populate the
// header switcher and any per-page company picker.
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companies = await prisma.company.findMany({
    where: allowed === null ? {} : { id: { in: allowed } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return NextResponse.json({
    companies,
    // SuperAdmin (allowed === null) sees the universe; "All" view spans every company.
    canViewAll: allowed === null || companies.length > 1,
  });
}
