import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isAnchoredProgram } from "@/lib/program-anchor";
import { requireAuth, handleAuthError } from "@/lib/auth";

/**
 * Lists the distinct partner programs configured in ProgramData, plus the
 * shape each one needs so the UI can auto-adapt:
 *  - `levels`: which stored requirement levels (Country / Region / CountrySet /
 *    Theatre / Global) the program's rows carry. These are the raw
 *    `ProgramLevel` values and each maps one-to-one onto a dashboard view
 *    (`program-levels.ts:scopeLevelOffered`) — "By Region" is offered only when
 *    Region rows exist; it is no longer derived from the Country rows.
 *  - `hasMinimumPerTheatre`: whether any requirement enforces a per-theatre
 *    minimum (drives the per-theatre breakdown on the Global level)
 *  - `isAnchored` / `anchorTheatre`: an anchored program offers only the
 *    "Target countries" view (`level=anchored`), so the dashboard reads this
 *    before asking for a report at all
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
    prisma.program.findMany({ select: { name: true, isTiered: true, anchorTheatre: true } }),
    prisma.programTier.findMany({ select: { programName: true } }),
  ]);

  const isTieredByName = new Map(registry.map((p) => [p.name, p.isTiered]));
  // An anchored program is reported over its anchor theatre + each partner's
  // target countries, in one view; the dashboard and planning need to know so
  // they offer only that view. Blank is not anchored (`isAnchoredProgram`).
  const anchorByName = new Map(
    registry.map((p) => [p.name, isAnchoredProgram(p) ? p.anchorTheatre!.trim() : null])
  );
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
      isAnchored: anchorByName.get(name) != null,
      anchorTheatre: anchorByName.get(name) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ programs });
}
