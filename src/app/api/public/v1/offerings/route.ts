import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { authorizePublicRequest } from "@/lib/public-api";
import { resolveOfferingGeo, computeOfferingCounts, type OfferingLevel } from "@/lib/offering-compliance";

/**
 * GET /api/public/v1/offerings — read-only offering definitions.
 *
 * Returns each offering's name/description/link and, per specialisation, the
 * supporting training requirements (with alternatives + minimum required).
 *
 * When `?country=` or `?region=` is supplied, each requirement is additionally
 * annotated with Onshore + Nearshore + Offshore distinct-holder counts (and a
 * `met` flag), scoped to the API key's companies. `?name=` narrows to a single
 * offering.
 */
export async function GET(request: NextRequest) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;

  const sp = request.nextUrl.searchParams;
  const nameFilter = sp.get("name")?.trim() || "";
  const country = sp.get("country")?.trim() || "";
  const region = sp.get("region")?.trim() || "";
  const level: OfferingLevel = region ? "region" : "country";
  const value = region || country;
  const wantsCompliance = value !== "" && ctx.companyIds.length > 0;

  // Offerings are tenant data — only list those owned by companies this key may
  // read. A key with no company grant sees nothing.
  if (ctx.companyIds.length === 0) {
    return NextResponse.json({ offerings: [] });
  }

  const offerings = await prisma.offering.findMany({
    where: {
      companyId: { in: ctx.companyIds },
      ...(nameFilter ? { name: nameFilter } : {}),
    },
    include: {
      specialisations: { include: { specialisation: { select: { id: true, name: true } } } },
      offeringData: {
        include: {
          specialisation: { select: { id: true, name: true } },
          trainingData: { select: { fullTitle: true } },
          alternatives: { include: { trainingData: { select: { fullTitle: true } } } },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  // Compute compliance once across all requirements when a scope is given.
  let geo: Awaited<ReturnType<typeof resolveOfferingGeo>> | null = null;
  let counts: Map<number, { onshore: number; nearshore: number; offshore: number }> = new Map();
  if (wantsCompliance) {
    geo = await resolveOfferingGeo(level, value);
    const allReqs = offerings.flatMap((o) =>
      o.offeringData.map((r) => ({
        id: r.id,
        trainingTitle: r.trainingTitle,
        alternatives: r.alternatives.map((a) => ({ trainingTitle: a.trainingTitle })),
        quantityRequired: r.quantityRequired,
      }))
    );
    counts = await computeOfferingCounts(allReqs, geo, ctx.companyIds);
  }

  const result = offerings.map((o) => {
    const specMap = new Map<number, { name: string; requirements: unknown[] }>();
    for (const link of o.specialisations) {
      specMap.set(link.specialisation.id, { name: link.specialisation.name, requirements: [] });
    }
    for (const r of o.offeringData) {
      if (!specMap.has(r.specialisationId)) {
        specMap.set(r.specialisationId, { name: r.specialisation?.name ?? "—", requirements: [] });
      }
      const c = counts.get(r.id);
      specMap.get(r.specialisationId)!.requirements.push({
        trainingType: r.trainingType,
        trainingTitle: r.trainingTitle,
        trainingFullTitle: r.trainingData?.fullTitle ?? null,
        quantityRequired: r.quantityRequired,
        alternatives: r.alternatives.map((a) => ({
          trainingType: a.trainingType,
          trainingTitle: a.trainingTitle,
          trainingFullTitle: a.trainingData?.fullTitle ?? null,
        })),
        ...(wantsCompliance
          ? {
              onshore: c?.onshore ?? 0,
              nearshore: geo?.hasNearshore ? c?.nearshore ?? 0 : null,
              offshore: geo?.hasOffshore ? c?.offshore ?? 0 : null,
              met: (c?.onshore ?? 0) >= r.quantityRequired,
            }
          : {}),
      });
    }
    return {
      name: o.name,
      companyId: o.companyId,
      description: o.description ?? null,
      link: o.link ?? null,
      specialisations: [...specMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  return NextResponse.json({
    ...(wantsCompliance && geo
      ? {
          scope: {
            level,
            value,
            onshoreCountries: geo.onshoreCountries,
            nearshoreCountries: geo.nearshoreCountries,
            offshoreCountries: geo.offshoreCountries,
            hasNearshore: geo.hasNearshore,
            hasOffshore: geo.hasOffshore,
          },
        }
      : {}),
    offerings: result,
  });
}
