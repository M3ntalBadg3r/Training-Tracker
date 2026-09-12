import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { authorizePublicRequest } from "@/lib/public-api";

/**
 * GET /api/public/v1/programs — read-only list of the configured partner
 * programs, plus the shape each one needs so consumers know how to query the
 * per-program compliance endpoint:
 *  - `levels`: which compliance levels (Country/Theatre/Global) are configured
 *  - `hasMinimumPerTheatre`: whether any requirement enforces a per-theatre
 *    minimum (Global Diamond-style per-theatre breakdown)
 *  - `isTiered`: whether the program has a tier ladder
 *
 * This list is deliberately NOT company-scoped, unlike every other endpoint on
 * this surface. Reviewed and kept, on this evidence:
 *
 *  - There is no tenant dimension to scope by. `Program`, `ProgramTier`,
 *    `ProgramData` and `Specialisation` carry no `companyId` in the schema —
 *    they are a global registry describing how this instance is configured.
 *    `Offering` is the deliberate contrast: it DOES carry a `companyId`,
 *    because offerings are tenant data. When something here is meant to be
 *    per-tenant, the schema says so.
 *  - Nothing per-company leaves this handler. The response is four fields per
 *    program — the program name, its configured levels, and two booleans — all
 *    read from the registry tables above. No student, completion, count,
 *    attainment or company value is read, derived or returned, so no key can
 *    learn anything about another key's companies from it. The compliance
 *    numbers that ARE tenant data live at `/api/public/v1/programs/{name}`,
 *    which scopes them to the key's companies.
 *  - A valid API key is still required, and the global public-API switch still
 *    gates it.
 *
 * The one thing that would invalidate this: if programs ever become per-tenant
 * (a `companyId` on `Program`, or programs offered to some companies and not
 * others), this list becomes tenant data and MUST be filtered by
 * `ctx.companyIds` like the rest of the surface. Treat adding that column as
 * the trigger to revisit this handler.
 */
export async function GET(request: NextRequest) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;

  const [rows, registry, tiers] = await Promise.all([
    prisma.programData.findMany({
      select: { programName: true, level: true, minimumPerTheatre: true },
    }),
    prisma.program.findMany({ select: { name: true, isTiered: true } }),
    prisma.programTier.findMany({ select: { programName: true } }),
  ]);

  const isTieredByName = new Map(registry.map((p) => [p.name, p.isTiered]));
  const hasTiers = new Set(tiers.map((t) => t.programName));

  const byProgram = new Map<string, { levels: Set<string>; hasMinimumPerTheatre: boolean }>();
  const ensure = (name: string) => {
    let entry = byProgram.get(name);
    if (!entry) {
      entry = { levels: new Set(), hasMinimumPerTheatre: false };
      byProgram.set(name, entry);
    }
    return entry;
  };
  for (const r of rows) {
    const entry = ensure(r.programName);
    entry.levels.add(r.level);
    if (r.minimumPerTheatre != null && r.minimumPerTheatre > 0) {
      entry.hasMinimumPerTheatre = true;
    }
  }
  // Tiered programs with tiers but no requirements yet should still show.
  for (const name of hasTiers) {
    if (isTieredByName.get(name)) ensure(name);
  }

  const programs = [...byProgram.entries()]
    .map(([name, info]) => ({
      name,
      levels: [...info.levels],
      hasMinimumPerTheatre: info.hasMinimumPerTheatre,
      isTiered: isTieredByName.get(name) === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ programs });
}
