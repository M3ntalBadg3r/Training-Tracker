import { COUNTRY_SET_SCOPE_ERROR, singleCompanyId } from "@/lib/country-sets";
import { getProgramAnchor, isAnchoredProgram } from "@/lib/program-anchor";
import { ANCHORED_SCOPE, type AnchoredPopulation } from "@/lib/program-levels";

/**
 * The request rules a program-dashboard view must pass before anything is
 * counted, shared by the internal (`/api/programs/[programName]`) and public
 * (`/api/public/v1/programs/[programName]`) routes so the two surfaces refuse
 * exactly the same requests with exactly the same messages.
 *
 *  - **An anchored program offers only the anchored view, and only an anchored
 *    program offers it.** Read single-level, an anchored program's Theatre rows
 *    would be counted as if its CountrySet rows did not exist (and vice versa),
 *    which is a plausible, wrong answer — so the mismatch is a 400 rather than
 *    a report.
 *  - **`countrySet` and `anchored` need exactly one company.** Both resolve a
 *    Country Set name, which only means something inside one company; across
 *    several, two partners' same-named sets would merge. The helpers would fail
 *    closed to an empty area, but that reads as an honest zero, hence the 400.
 *    Naming the rule is safe: it depends only on the caller's own scope.
 *  - **An anchored roster names its population** (`theatre` or
 *    `targetCountries`), so the list matches the row's own figure.
 *
 * Every message is fixed text: none echoes a value from the request or the DB.
 * Server-only (imports Prisma via `program-anchor`).
 */

export const NOT_ANCHORED_ERROR = "This program is not anchored; level=anchored is not available for it";
export const ANCHORED_ONLY_ERROR =
  "This program is anchored: it is reported only by its target countries (level=anchored)";
export const POPULATION_REQUIRED_ERROR =
  "An anchored roster needs population=theatre or population=targetCountries";

/** Validate a user-supplied population. */
export function parseAnchoredPopulation(v: string | null | undefined): AnchoredPopulation | null {
  return v === "theatre" || v === "targetCountries" ? v : null;
}

export async function checkProgramViewRequest(opts: {
  programName: string;
  level: string;
  companyIds: number[] | null;
  studentsMode: boolean;
  population: string | null;
}): Promise<{ error: string } | { population: AnchoredPopulation | null }> {
  const { level } = opts;
  const anchored = isAnchoredProgram(await getProgramAnchor(opts.programName));
  if (level === ANCHORED_SCOPE && !anchored) return { error: NOT_ANCHORED_ERROR };
  if (anchored && level !== ANCHORED_SCOPE) return { error: ANCHORED_ONLY_ERROR };
  if ((level === "countrySet" || level === ANCHORED_SCOPE) && singleCompanyId(opts.companyIds) === null) {
    return { error: COUNTRY_SET_SCOPE_ERROR };
  }
  if (level !== ANCHORED_SCOPE) return { population: null };
  const population = parseAnchoredPopulation(opts.population);
  if (opts.studentsMode && population === null) return { error: POPULATION_REQUIRED_ERROR };
  return { population };
}
