import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { authorizePublicRequest } from "@/lib/public-api";

/**
 * GET /api/public/v1/country-sets — the Country Sets owned by the key's
 * companies, each with its member countries.
 *
 * The program and planning endpoints accept `level=countrySet&countrySet=<name>`
 * and list the usable names, but nothing else tells a caller which countries a
 * set covers. This is that read.
 *
 * **Multi-company keys are fine here**, unlike `level=countrySet` reports. The
 * single-company rule exists because resolving one *name* across several
 * companies would merge two partners' same-named sets into one area. Listing
 * merges nothing: every row is one company's own set and carries its
 * `companyId`, so two same-named sets come back as two rows.
 *
 * Empty sets are included (`countries: []`) — this lists definitions, whereas
 * the `countrySets` pick-lists leave them out because an empty area can never
 * be met. `?name=` is an exact match, like offerings'. Uncached: one small
 * indexed query with nothing to aggregate (as `offerings` and `students`).
 *
 * The response is built field by field — no internal `id` (no public endpoint
 * takes one, and they are sequential) and no timestamps.
 */
export async function GET(request: NextRequest) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;

  // Country Sets are tenant data — a key with no company grant sees nothing.
  if (ctx.companyIds.length === 0) {
    return NextResponse.json({ countrySets: [] });
  }

  const name = request.nextUrl.searchParams.get("name")?.trim() || "";

  const sets = await prisma.countrySet.findMany({
    where: { companyId: { in: ctx.companyIds }, ...(name ? { name } : {}) },
    select: {
      companyId: true,
      name: true,
      description: true,
      members: { select: { country: true } },
    },
    orderBy: [{ companyId: "asc" }, { name: "asc" }],
  });

  return NextResponse.json({
    countrySets: sets.map((s) => ({
      companyId: s.companyId,
      name: s.name,
      description: s.description,
      countries: s.members.map((m) => m.country).sort((a, b) => a.localeCompare(b)),
    })),
  });
}
