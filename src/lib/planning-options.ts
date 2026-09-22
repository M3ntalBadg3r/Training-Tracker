import prisma from "@/lib/prisma";

/** Per-program metadata for the Compliance Planning target selector. */
export interface PlanningOption {
  name: string;
  isTiered: boolean;
  levels: string[];
  tiers: string[];
  specialisations: string[];
}

/**
 * The selector metadata behind Compliance Planning: every program with the tier
 * and specialisation *names* a caller needs in order to build a `targets` array
 * (`{ program, mode, tier?, specialisations?[] }`).
 *
 * Company-agnostic by construction — `Program`, `ProgramData` and `ProgramTier`
 * carry no `companyId`, and nothing here reads a student, completion or count.
 * That is the same reasoning written out at length in
 * `src/app/api/public/v1/programs/route.ts`, and it carries the same trigger: if
 * programs ever gain a company dimension, every caller of this must filter by
 * it. Both routes key their cache on the company scope anyway, so the day that
 * changes there is no shared-key leak to discover as well as a filter to add.
 */
export async function buildPlanningOptions(): Promise<PlanningOption[]> {
  const [programs, programData, tiers] = await Promise.all([
    prisma.program.findMany({ select: { name: true, isTiered: true } }),
    prisma.programData.findMany({
      select: { programName: true, level: true, specialisation: { select: { name: true } } },
    }),
    prisma.programTier.findMany({ orderBy: { sortOrder: "asc" }, select: { programName: true, name: true } }),
  ]);

  const isTieredByName = new Map(programs.map((p) => [p.name, p.isTiered]));
  const names = new Set<string>([
    ...programs.filter((p) => p.isTiered).map((p) => p.name),
    ...programData.map((d) => d.programName),
  ]);

  const result: PlanningOption[] = [];
  for (const name of [...names].sort()) {
    const rows = programData.filter((d) => d.programName === name);
    const levels = [...new Set(rows.map((d) => d.level))];
    const specialisations = [
      ...new Set(rows.map((d) => d.specialisation?.name).filter((n): n is string => !!n)),
    ].sort();
    const tierNames = tiers.filter((t) => t.programName === name).map((t) => t.name);
    result.push({
      name,
      isTiered: isTieredByName.get(name) === true,
      levels,
      tiers: tierNames,
      specialisations,
    });
  }
  return result;
}
