import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { invalidateReportCache } from "@/lib/report-cache";
import { readJsonBody } from "@/lib/request-body";
import { REQ_LEVELS, isProgramWideRow } from "@/lib/program-levels";
import { parseAnchorSettings } from "@/lib/program-data-write";

const levelRank = (l: string) => (REQ_LEVELS as readonly string[]).indexOf(l);

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
        specialisationId: true,
        tierId: true,
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
    /** Registry id — null only for legacy rows with no Program row. */
    id: number | null;
    anchorTheatre: string | null;
    defaultMinimumCountries: number | null;
    /** Rows with neither a specialisation nor a tier (tiered programs only). */
    programWideCount: number;
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
        id: null,
        anchorTheatre: null,
        defaultMinimumCountries: null,
        programWideCount: 0,
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
    a.id = p.id;
    a.anchorTheatre = p.anchorTheatre?.trim() ? p.anchorTheatre.trim() : null;
    a.defaultMinimumCountries = p.defaultMinimumCountries;
  }

  for (const r of rows) {
    const a = ensure(r.programName);
    a.requirementCount += 1;
    if (r.specialisation?.name) a.specialisations.add(r.specialisation.name);
    if (r.level) a.levels.add(r.level);
    if (r.minimumPerTheatre != null) a.hasMinimumPerTheatre = true;
    if (isProgramWideRow(r)) a.programWideCount += 1;
  }

  for (const t of tiers) ensure(t.programName).tierCount += 1;

  const result = [...agg.entries()]
    .map(([name, a]) => ({
      name,
      requirementCount: a.requirementCount,
      specialisations: [...a.specialisations].sort(),
      // Canonical level order (Country, Region, Country Set, Theatre, Global)
      // rather than alphabetical, so the admin card reads the same everywhere.
      levels: [...a.levels].sort((x, y) => levelRank(x) - levelRank(y)),
      hasMinimumPerTheatre: a.hasMinimumPerTheatre,
      isTiered: a.isTiered,
      deploymentMode: a.deploymentMode,
      tierCount: a.tierCount,
      id: a.id,
      anchorTheatre: a.anchorTheatre,
      defaultMinimumCountries: a.defaultMinimumCountries,
      programWideCount: a.programWideCount,
    }))
    .sort((x, y) => x.name.localeCompare(y.name));

  return NextResponse.json(result);
}

/**
 * POST /api/admin/program-data/program
 * Creates an empty program (registry row). Body: { name, isTiered?,
 * deploymentMode?, anchorTheatre?, defaultMinimumCountries? }. An anchor
 * theatre must exist in Region Data (400 otherwise); the default minimum is a
 * whole number 1–1000 or null.
 */
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const parsed = await readJsonBody(request, 64 * 1024);
  if (!parsed.ok) return parsed.response;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const body = parsed.body as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Program name is required" }, { status: 400 });
  }
  const isTiered = body.isTiered === true;
  const DEPLOYMENT_MODES = ["flat", "perAchievedSpecialisation", "perTierPerSpecialisation"];
  const deploymentMode =
    typeof body.deploymentMode === "string" && DEPLOYMENT_MODES.includes(body.deploymentMode)
      ? body.deploymentMode
      : "flat";
  const anchor = await parseAnchorSettings(body);
  if (!anchor.ok) {
    return NextResponse.json({ error: anchor.error }, { status: 400 });
  }
  const anchorTheatre = anchor.value.anchorTheatre ?? null;
  const defaultMinimumCountries = anchor.value.defaultMinimumCountries ?? null;

  const existing = await prisma.program.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json({ error: "A program with this name already exists" }, { status: 409 });
  }

  const program = await prisma.program.create({
    data: { name, isTiered, deploymentMode, anchorTheatre, defaultMinimumCountries },
  });
  invalidateReportCache();
  return NextResponse.json(
    {
      id: program.id,
      name: program.name,
      isTiered: program.isTiered,
      deploymentMode: program.deploymentMode,
      anchorTheatre: program.anchorTheatre,
      defaultMinimumCountries: program.defaultMinimumCountries,
      warnings: [] as string[],
    },
    { status: 201 }
  );
}
