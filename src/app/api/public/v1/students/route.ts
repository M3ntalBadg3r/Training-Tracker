import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { authorizePublicRequest } from "@/lib/public-api";

/**
 * GET /api/public/v1/students — read-only student roster for the API key's
 * companies. Optional `?companyId=` narrows to a single granted company.
 */
export async function GET(request: NextRequest) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.companyIds.length === 0) return NextResponse.json([]);

  const students = await prisma.student.findMany({
    where: { companyId: { in: ctx.companyIds } },
    include: { regionData: true, company: { select: { id: true, name: true } } },
    orderBy: { fullName: "asc" },
  });

  return NextResponse.json(
    students.map((s) => ({
      email: s.email,
      fullName: s.fullName,
      theatre: s.theatre,
      country: s.country,
      region: s.regionData?.region ?? null,
      companyId: s.companyId,
      companyName: s.company?.name ?? null,
    }))
  );
}
