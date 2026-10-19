import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

/**
 * Lists the distinct partner programs configured in ProgramData, plus the
 * shape each one needs so the UI can auto-adapt:
 *  - `levels`: which stored requirement levels (Country / Region / CountrySet /
 *    TargetCountries / Theatre / Global) the program's rows carry. These are
 *    the raw `ProgramLevel` values; `program-levels.ts:scopeLevelOffered` maps
 *    them onto dashboard views (By Theatre reads Theatre + TargetCountries) — "By Region" is offered only when
 *    Region rows exist; it is no longer derived from the Country rows.
 *  - `hasMinimumPerTheatre`: whether any requirement enforces a per-theatre
 *    minimum (drives the per-theatre breakdown on the Global level)
 *  - `description`: the program's own description, or null
 *  - `hasTargetCountries`: the program has TargetCountries rows, so its By
 *    Theatre view also counts each partner's target countries inside the
 *    viewed theatre (`program-target-countries.ts`)
 *
 * This single endpoint feeds the programs index page and the sidebar submenu,
 * replacing the two previously-hardcoded per-program entries.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const [rows, registry, tiers] = await Promise.all([
    prisma.programData.findMany({
      select: { programName: true, level: true, minimumPerTheatre: true },
    }),
    prisma.program.findMany({ select: { name: true, isTiered: true, description: true } }),
    prisma.programTier.findMany({ select: { programName: true } }),
  ]);

  const isTieredByName = new Map(registry.map((p) => [p.name, p.isTiered]));
  const descriptionByName = new Map(registry.map((p) => [p.name, p.description]));
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
      // The program's free-text description (display only), or null.
      description: descriptionByName.get(name) ?? null,
      isTiered: isTieredByName.get(name) === true,
      // A program with TargetCountries rows judges its By Theatre view over
      // the theatre AND each partner's target countries inside it, which
      // needs exactly one company; the dashboard reads this to know.
      hasTargetCountries: info.levels.has("TargetCountries"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ programs });
}
