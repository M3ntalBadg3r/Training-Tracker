/**
 * Shared compliance calculation utilities used by the APS and Global Diamond
 * program dashboards and the Program Compliance Trend report.
 *
 * The data model centres on ProgramData rows, each of which may have
 * ProgramDataAlternative children (OR logic — any of {primary, ...alternatives}
 * counts toward the requirement's quantity). A "compliant" requirement is one
 * where the union of unique students holding any qualifying training meets or
 * exceeds quantityRequired (and, for Global Diamond requirements with a
 * minimumPerTheatre, every theatre meets that minimum too).
 */

import prisma from "@/lib/prisma";

export interface ComplianceScope {
  country?: string;
  countries?: string[];
  theatre?: string;
}

/** A program data row shape sufficient for compliance calculations. */
export interface ProgramRequirement {
  trainingTitle: string | null;
  alternatives: { trainingTitle: string }[];
  quantityRequired: number;
  minimumPerTheatre?: number | null;
}

/** Resolve a region name to its member countries (via RegionData). */
export async function countriesInRegion(region: string): Promise<string[]> {
  if (!region) return [];
  const rows = await prisma.regionData.findMany({
    where: { region },
    select: { country: true },
  });
  return rows.map((r: { country: string }) => r.country);
}

/** Collect the unique union of primary + alternative training titles. */
export function extractTitles(rows: ProgramRequirement[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    if (r.trainingTitle) set.add(r.trainingTitle);
    for (const alt of r.alternatives) set.add(alt.trainingTitle);
  }
  return [...set];
}

/**
 * Email-sets keyed by training title for a given scope, considering only
 * trainings that are active as of `asOf` (expiry date strictly greater than
 * `asOf`). Empty input → empty map.
 */
export async function getEmailSetsByTitle(
  trainingTitles: string[],
  asOf: Date,
  scope: ComplianceScope = {}
): Promise<Map<string, Set<string>>> {
  if (trainingTitles.length === 0) return new Map();

  const studentFilter: Record<string, unknown> = {};
  if (scope.country) studentFilter.country = scope.country;
  if (scope.countries) studentFilter.country = { in: scope.countries };
  if (scope.theatre) studentFilter.theatre = scope.theatre;

  const rows = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: trainingTitles },
      expiryDate: { gt: asOf },
      ...(Object.keys(studentFilter).length > 0 ? { student: studentFilter } : {}),
    },
    select: { trainingTitle: true, email: true },
  });

  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.trainingTitle)) map.set(r.trainingTitle, new Set());
    map.get(r.trainingTitle)!.add(r.email);
  }
  return map;
}

/**
 * Email sets keyed by trainingTitle and then by theatre. Used for Global
 * Diamond's per-theatre breakdown.
 */
export async function getEmailSetsByTitleAndTheatre(
  trainingTitles: string[],
  asOf: Date
): Promise<Map<string, Map<string, Set<string>>>> {
  if (trainingTitles.length === 0) return new Map();
  const rows = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: trainingTitles },
      expiryDate: { gt: asOf },
    },
    select: {
      trainingTitle: true,
      email: true,
      student: { select: { theatre: true } },
    },
  });

  const map = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    let byTheatre = map.get(r.trainingTitle);
    if (!byTheatre) {
      byTheatre = new Map();
      map.set(r.trainingTitle, byTheatre);
    }
    const theatre = r.student.theatre;
    if (!byTheatre.has(theatre)) byTheatre.set(theatre, new Set());
    byTheatre.get(theatre)!.add(r.email);
  }
  return map;
}

/** Union of unique emails across primary + alternatives, given an emailSets map. */
export function unionAttained(req: ProgramRequirement, emailSets: Map<string, Set<string>>): number {
  if (!req.trainingTitle) return 0;
  const titles = [req.trainingTitle, ...req.alternatives.map((a) => a.trainingTitle)];
  const u = new Set<string>();
  for (const t of titles) {
    const set = emailSets.get(t);
    if (set) for (const e of set) u.add(e);
  }
  return u.size;
}

/** Per-theatre attained counts for a requirement (used when minimumPerTheatre is set). */
export function unionAttainedByTheatre(
  req: ProgramRequirement,
  byTitleAndTheatre: Map<string, Map<string, Set<string>>>,
  theatres: string[]
): { theatre: string; count: number }[] {
  if (!req.trainingTitle) return [];
  const titles = [req.trainingTitle, ...req.alternatives.map((a) => a.trainingTitle)];
  return theatres.map((theatre) => {
    const u = new Set<string>();
    for (const t of titles) {
      const set = byTitleAndTheatre.get(t)?.get(theatre);
      if (set) for (const e of set) u.add(e);
    }
    return { theatre, count: u.size };
  });
}

/** Return the list of distinct, non-empty theatre names across all students. */
export async function listTheatres(): Promise<string[]> {
  const rows = await prisma.student.findMany({
    select: { theatre: true },
    distinct: ["theatre"],
    orderBy: { theatre: "asc" },
  });
  return rows.map((r: { theatre: string }) => r.theatre).filter(Boolean);
}
