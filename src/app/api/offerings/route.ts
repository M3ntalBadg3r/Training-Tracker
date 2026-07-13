import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

/**
 * GET /api/offerings
 * Lists offerings for the index page + sidebar. No company scoping (the
 * definition is global reference data, like /api/programs).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const [offerings, specLinks] = await Promise.all([
    prisma.offering.findMany({ orderBy: { name: "asc" } }),
    prisma.offeringSpecialisation.findMany({ select: { offeringName: true } }),
  ]);

  const specCount = new Map<string, number>();
  for (const s of specLinks) specCount.set(s.offeringName, (specCount.get(s.offeringName) ?? 0) + 1);

  const result = offerings.map((o) => ({
    name: o.name,
    description: o.description ?? null,
    link: o.link ?? null,
    specialisationCount: specCount.get(o.name) ?? 0,
  }));

  return NextResponse.json({ offerings: result });
}
