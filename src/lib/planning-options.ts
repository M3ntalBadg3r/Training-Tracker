import prisma from "@/lib/prisma";
import { REQ_LEVELS } from "@/lib/program-levels";
import { isAnchoredProgram } from "@/lib/program-anchor";

/** Per-program metadata for the Compliance Planning target selector. */
export interface PlanningOption {
  name: string;
  isTiered: boolean;
  /**
   * The requirement levels this program's rows are authored at — any of
   * Country, Region, CountrySet, Theatre and Global, in that order. A planning
   * scope is only worth offering when some program carries its level
   * (`scopeLevelOffered`), because each scope plans against its own level's
   * rows and nothing else.
   */
  levels: string[];
  tiers: string[];
  specialisations: string[];
  /**
   * Set when the program is anchored (`Program.anchorTheatre`): it is planned
   * only at the anchored scope ("Target countries"), over its Theatre rows in
   * this theatre and its CountrySet rows in the partner's target countries —
   * and never at any other scope. `null` for every standard program.
   * Registry data like the rest of this record: the theatre is a property of
   * the program, not of any company.
   */
  anchored: { anchorTheatre: string } | null;
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
    prisma.program.findMany({ select: { name: true, isTiered: true, anchorTheatre: true } }),
    prisma.programData.findMany({
      select: { programName: true, level: true, specialisation: { select: { name: true } } },
    }),
    prisma.programTier.findMany({ orderBy: { sortOrder: "asc" }, select: { programName: true, name: true } }),
  ]);

  const isTieredByName = new Map(programs.map((p) => [p.name, p.isTiered]));
  const anchorByName = new Map(
    programs.filter((p) => isAnchoredProgram(p)).map((p) => [p.name, p.anchorTheatre!.trim()]),
  );
  const names = new Set<string>([
    ...programs.filter((p) => p.isTiered).map((p) => p.name),
    ...programData.map((d) => d.programName),
  ]);

  const result: PlanningOption[] = [];
  for (const name of [...names].sort()) {
    const rows = programData.filter((d) => d.programName === name);
    const present = new Set<string>(rows.map((d) => d.level));
    const levels = REQ_LEVELS.filter((l) => present.has(l));
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
      anchored: anchorByName.has(name) ? { anchorTheatre: anchorByName.get(name)! } : null,
    });
  }
  return result;
}
