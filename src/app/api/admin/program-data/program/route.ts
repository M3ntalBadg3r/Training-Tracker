import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { invalidateReportCache } from "@/lib/report-cache";

/**
 * GET /api/admin/program-data/program
 * Returns the program registry (one entry per Program row) with aggregated
 * metadata from its ProgramData requirements. Empty programs come through with
 * requirementCount: 0. This is the data source for the admin card index.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const [programs, rows, tiers] = await Promise.all([
    prisma.program.findMany({ orderBy: { name: "asc" } }),
    prisma.programData.findMany({
      select: {
        programName: true,
        level: true,
        minimumPerTheatre: true,
        specialisation: { select: { name: true } },
      },
    }),
    prisma.programTier.findMany({ select: { programName: true } }),
  ]);

  interface Agg {
    requirementCount: number;
    specialisations: Set<string>;
    levels: Set<string>;
    hasMinimumPerTheatre: boolean;
    isTiered: boolean;
    deploymentMode: string;
    tierCount: number;
  }
  const agg = new Map<string, Agg>();
  const ensure = (name: string): Agg => {
    let a = agg.get(name);
    if (!a) {
      a = {
        requirementCount: 0,
        specialisations: new Set(),
        levels: new Set(),
        hasMinimumPerTheatre: false,
        isTiered: false,
        deploymentMode: "flat",
        tierCount: 0,
      };
      agg.set(name, a);
    }
    return a;
  };

  // Seed from the registry so empty programs are included (and carry settings).
  for (const p of programs) {
    const a = ensure(p.name);
    a.isTiered = p.isTiered;
    a.deploymentMode = p.deploymentMode;
  }

  for (const r of rows) {
    const a = ensure(r.programName);
    a.requirementCount += 1;
    if (r.specialisation?.name) a.specialisations.add(r.specialisation.name);
    if (r.level) a.levels.add(r.level);
    if (r.minimumPerTheatre != null) a.hasMinimumPerTheatre = true;
  }

  for (const t of tiers) ensure(t.programName).tierCount += 1;

  const result = [...agg.entries()]
    .map(([name, a]) => ({
      name,
      requirementCount: a.requirementCount,
      specialisations: [...a.specialisations].sort(),
      levels: [...a.levels].sort(),
      hasMinimumPerTheatre: a.hasMinimumPerTheatre,
      isTiered: a.isTiered,
      deploymentMode: a.deploymentMode,
      tierCount: a.tierCount,
    }))
    .sort((x, y) => x.name.localeCompare(y.name));

  return NextResponse.json(result);
}

/**
 * POST /api/admin/program-data/program
 * Creates an empty program (registry row). Body: { name }.
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
    return NextResponse.json({ error: "Program name is required" }, { status: 400 });
  }
  const isTiered = body?.isTiered === true;
  const DEPLOYMENT_MODES = ["flat", "perAchievedSpecialisation", "perTierPerSpecialisation"];
  const deploymentMode = DEPLOYMENT_MODES.includes(body?.deploymentMode) ? body.deploymentMode : "flat";

  const existing = await prisma.program.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json({ error: "A program with this name already exists" }, { status: 409 });
  }

  const program = await prisma.program.create({ data: { name, isTiered, deploymentMode } });
  invalidateReportCache();
  return NextResponse.json(
    { id: program.id, name: program.name, isTiered: program.isTiered, deploymentMode: program.deploymentMode },
    { status: 201 }
  );
}
