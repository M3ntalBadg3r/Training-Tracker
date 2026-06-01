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

  const rows = await prisma.programData.findMany({
    select: { programName: true, level: true, minimumPerTheatre: true },
  });

  const byProgram = new Map<string, { levels: Set<string>; hasMinimumPerTheatre: boolean }>();
  for (const r of rows) {
    let entry = byProgram.get(r.programName);
    if (!entry) {
      entry = { levels: new Set(), hasMinimumPerTheatre: false };
      byProgram.set(r.programName, entry);
    }
    entry.levels.add(r.level);
    if (r.minimumPerTheatre != null && r.minimumPerTheatre > 0) {
      entry.hasMinimumPerTheatre = true;
    }
  }

  const programs = [...byProgram.entries()]
    .map(([name, info]) => ({
      name,
      levels: [...info.levels],
      hasMinimumPerTheatre: info.hasMinimumPerTheatre,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ programs });
}
