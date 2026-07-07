import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

/**
 * Lists the distinct partner programs configured in ProgramData, plus the
 * shape each one needs so the UI can auto-adapt:
 *  - `levels`: which compliance levels (Country/Theatre/Global) are configured
 *  - `hasMinimumPerTheatre`: whether any requirement enforces a per-theatre
 *    minimum (drives the Global Diamond-style per-theatre breakdown)
 *
 * This single endpoint feeds the programs index page and the sidebar submenu,
 * replacing the previously-hardcoded APS / Global Diamond entries.
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
