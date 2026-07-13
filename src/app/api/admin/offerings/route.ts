import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

/**
 * GET /api/admin/offerings
 * Returns the offering registry (one entry per Offering row) with its selected
 * specialisations and a requirement count. Data source for the admin card index.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const [offerings, specLinks, rows] = await Promise.all([
    prisma.offering.findMany({ orderBy: { name: "asc" } }),
    prisma.offeringSpecialisation.findMany({
      include: { specialisation: { select: { name: true } } },
    }),
    prisma.offeringData.findMany({ select: { offeringName: true } }),
  ]);

  const specsByOffering = new Map<string, Set<string>>();
  for (const link of specLinks) {
    if (!specsByOffering.has(link.offeringName)) specsByOffering.set(link.offeringName, new Set());
    if (link.specialisation?.name) specsByOffering.get(link.offeringName)!.add(link.specialisation.name);
  }
  const reqCountByOffering = new Map<string, number>();
  for (const r of rows) reqCountByOffering.set(r.offeringName, (reqCountByOffering.get(r.offeringName) ?? 0) + 1);

  const result = offerings.map((o) => ({
    name: o.name,
    description: o.description ?? null,
    link: o.link ?? null,
    specialisations: [...(specsByOffering.get(o.name) ?? new Set<string>())].sort(),
    requirementCount: reqCountByOffering.get(o.name) ?? 0,
  }));

  return NextResponse.json(result);
}

/**
 * POST /api/admin/offerings
 * Creates an offering. Body: { name, description?, link?, specialisationIds?[] }.
 */
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Offering name is required" }, { status: 400 });
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

  const existing = await prisma.offering.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json({ error: "An offering with this name already exists" }, { status: 409 });
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
    { id: offering.id, name: offering.name, description: offering.description, link: offering.link },
    { status: 201 }
  );
}
