import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { safeDecodeParam, safeExternalUrl } from "@/lib/utils";
import {
  resolveOfferingGeo,
  computeOfferingCounts,
  computeOfferingCountryBreakdown,
  type HoldersByCountry,
  type OfferingLevel,
} from "@/lib/offering-compliance";

/**
 * GET /api/offerings/[offeringName]
 * Data-driven offering dashboard. Returns the offering definition + the
 * countries/regions available for the scope selector, and — when a country or
 * region is selected — per-specialisation requirements with Onshore + Nearshore
 * + Offshore distinct-holder counts and Met flags, plus a per-country
 * distinct-holder breakdown of the same numbers (`holdersByCountry`, keyed by
 * the app's own country name). Company-scoped (compliance = students).
 *
 * `?students=true&scope=onshore|nearshore|offshore&trainingTitle=<csv>&level=&country=|region=`
 * returns the drill-down student list for a requirement.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ offeringName: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { offeringName: rawName } = await params;
  const name = safeDecodeParam(rawName);
  if (name === null) {
    return NextResponse.json({ error: "Invalid offering name" }, { status: 400 });
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));
  const noCompanies = companyFilter !== null && companyFilter.length === 0;

  const sp = request.nextUrl.searchParams;
  const levelParam = sp.get("level") === "region" ? "region" : "country";
  const level = levelParam as OfferingLevel;
  const value = (level === "country" ? sp.get("country") : sp.get("region"))?.trim() || "";
  const studentsMode = sp.get("students") === "true";

  // --- Student drill-down mode ---
  if (studentsMode) {
    if (noCompanies) return NextResponse.json({ students: [] });
    const titles = (sp.get("trainingTitle") || "").split(",").map((t) => t.trim()).filter(Boolean);
    const scopeRaw = sp.get("scope");
    const scopeSide = scopeRaw === "offshore" ? "offshore" : scopeRaw === "nearshore" ? "nearshore" : "onshore";
    if (titles.length === 0 || !value) return NextResponse.json({ students: [] });
    const geo = await resolveOfferingGeo(level, value);
    const countries =
      scopeSide === "offshore"
        ? geo.offshoreCountries
        : scopeSide === "nearshore"
        ? geo.nearshoreCountries
        : geo.onshoreCountries;
    return getOfferingStudents(titles, countries, companyFilter);
  }

  // --- Definition + optional compliance ---
  // Offerings are tenant data: only resolve one the caller can see. The client
  // always scopes to a single company, so `companyFilter` is normally a single
  // id; an out-of-scope request (noCompanies) can never match.
  const offering = noCompanies
    ? null
    : await prisma.offering.findFirst({
        where: { name, ...(companyFilter ? { companyId: { in: companyFilter } } : {}) },
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
      });
  if (!offering) {
    return NextResponse.json({ error: "Offering not found" }, { status: 404 });
  }

  // Countries (with a theatre) + regions for the scope selector.
  const regionRows = await prisma.regionData.findMany({
    where: { theatre: { not: null } },
    select: { country: true, region: true },
    orderBy: { country: "asc" },
  });
  const countries = regionRows.map((r) => r.country);
  const regions = [...new Set(regionRows.map((r) => r.region))].sort();

  // Build the specialisation → requirements structure. Include selected
  // specialisations even if they carry no requirements yet.
  interface ReqOut {
    id: number;
    trainingType: string | null;
    trainingTitle: string | null;
    trainingFullTitle: string;
    quantityRequired: number;
    alternatives: { trainingType: string; trainingTitle: string; trainingFullTitle: string }[];
    onshore: number | null;
    nearshore: number | null;
    offshore: number | null;
    met: boolean | null;
    /**
     * Distinct holders of this requirement per country, keyed by the app's own
     * country name. A DISTRIBUTION of the three band counts, not a per-country
     * verdict: `met` is decided on the Onshore set as a whole, so three holders
     * in three countries meet a requirement of 3 that no single country meets.
     * Countries with no holders are omitted. Null until a scope is selected.
     */
    holdersByCountry: HoldersByCountry | null;
  }
  const specMap = new Map<number, { name: string; requirements: ReqOut[] }>();
  for (const link of offering.specialisations) {
    specMap.set(link.specialisation.id, { name: link.specialisation.name, requirements: [] });
  }
  for (const r of offering.offeringData) {
    const specId = r.specialisationId;
    if (!specMap.has(specId)) {
      specMap.set(specId, { name: r.specialisation?.name ?? "—", requirements: [] });
    }
    specMap.get(specId)!.requirements.push({
      id: r.id,
      trainingType: r.trainingType ?? null,
      trainingTitle: r.trainingTitle ?? null,
      trainingFullTitle: r.trainingData?.fullTitle ?? "—",
      quantityRequired: r.quantityRequired,
      alternatives: r.alternatives.map((a) => ({
        trainingType: a.trainingType,
        trainingTitle: a.trainingTitle,
        trainingFullTitle: a.trainingData?.fullTitle ?? "—",
      })),
      onshore: null,
      nearshore: null,
      offshore: null,
      met: null,
      holdersByCountry: null,
    });
  }

  // Resolve compliance when a scope value is selected + companies are in scope.
  let geoOut: Awaited<ReturnType<typeof resolveOfferingGeo>> | null = null;
  let holdersByCountry: HoldersByCountry | null = null;
  if (value && !noCompanies) {
    geoOut = await resolveOfferingGeo(level, value);
    const allReqs = [...specMap.values()].flatMap((s) =>
      s.requirements.map((r) => ({
        id: r.id,
        trainingTitle: r.trainingTitle,
        alternatives: r.alternatives.map((a) => ({ trainingTitle: a.trainingTitle })),
        quantityRequired: r.quantityRequired,
      }))
    );
    // Two passes over the same scope: the band totals the table shows, and the
    // per-country decomposition of those same totals for a map. They share the
    // counting LOGIC but not a snapshot — each takes its own `new Date()` and
    // issues its own queries, in separate transactions. So a completion that
    // expires, or an import that commits, between the two round-trips can leave
    // the table reading `onshore: 7` while the map sums to 6. Vanishingly
    // unlikely, but worth knowing before chasing it: verify the "per-country
    // sums to the band total" property against a quiesced dataset, or hoist a
    // single `now` through both.
    const [counts, breakdown] = await Promise.all([
      computeOfferingCounts(allReqs, geoOut, companyFilter),
      computeOfferingCountryBreakdown(allReqs, geoOut, companyFilter),
    ]);
    for (const spec of specMap.values()) {
      for (const req of spec.requirements) {
        const c = counts.get(req.id) ?? { onshore: 0, nearshore: 0, offshore: 0 };
        req.onshore = c.onshore;
        req.nearshore = geoOut.hasNearshore ? c.nearshore : null;
        req.offshore = geoOut.hasOffshore ? c.offshore : null;
        req.met = c.onshore >= req.quantityRequired;
        req.holdersByCountry = breakdown.byRequirement.get(req.id) ?? {};
      }
    }
    holdersByCountry = breakdown.overall;
  }

  const specialisations = [...specMap.values()]
    .map((s) => ({
      name: s.name,
      requirements: s.requirements,
      met:
        value && !noCompanies && s.requirements.length > 0
          ? s.requirements.every((r) => r.met === true)
          : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({
    name: offering.name,
    description: offering.description ?? null,
    link: safeExternalUrl(offering.link),
    countries,
    regions,
    specialisations,
    geo: geoOut,
    // Whole-offering distribution: distinct holders per country of ANY
    // qualifying training in this offering. Not the sum of the per-requirement
    // maps (one person may hold several), and not a compliance verdict — see
    // `HoldersByCountry`. Null until a scope value is selected.
    holdersByCountry,
  });
}

/** Distinct active holders (latest completion per email) across the countries. */
async function getOfferingStudents(
  trainingTitles: string[],
  countries: string[],
  companyFilter: number[] | null
) {
  const now = new Date();
  if (countries.length === 0) return NextResponse.json({ students: [] });

  const studentFilter: Record<string, unknown> = { country: { in: countries } };
  // An empty array means "scoped to no companies" and must match nothing; `[]`
  // is truthy and yields `in: []`. `null` remains the deliberate "unrestricted"
  // case. Testing `length > 0` here dropped the filter instead — fail-open. The
  // caller guards on an empty scope already, so this was not reachable.
  if (companyFilter) studentFilter.companyId = { in: companyFilter };

  const records = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: trainingTitles },
      expiryDate: { gt: now },
      student: studentFilter,
    },
    include: {
      student: { select: { fullName: true, email: true, country: true, theatre: true } },
      trainingData: { select: { fullTitle: true } },
    },
    orderBy: { student: { fullName: "asc" } },
  });

  const emailMap = new Map<string, (typeof records)[0]>();
  for (const r of records) {
    const existing = emailMap.get(r.email);
    if (!existing || r.completedDate > existing.completedDate) emailMap.set(r.email, r);
  }

  const students = Array.from(emailMap.values()).map((r) => ({
    fullName: r.student.fullName,
    email: r.email,
    country: r.student.country,
    theatre: r.student.theatre,
    completedDate: r.completedDate.toISOString().split("T")[0],
    expiryDate: r.expiryDate.toISOString().split("T")[0],
    training: r.trainingData?.fullTitle ?? r.trainingTitle,
  }));

  return NextResponse.json({ students });
}
