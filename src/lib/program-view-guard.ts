import { COUNTRY_SET_SCOPE_ERROR, singleCompanyId } from "@/lib/country-sets";
import { programHasTargetCountryRows } from "@/lib/program-target-countries";
import { parsePopulationKind, type PopulationKind } from "@/lib/program-levels";

/**
 * The request rules a program-dashboard view must pass before anything is
 * counted, shared by the internal (`/api/programs/[programName]`) and public
 * (`/api/public/v1/programs/[programName]`) routes so the two surfaces refuse
 * exactly the same requests with exactly the same messages.
 *
 *  - **`level=countrySet` needs exactly one company.** It resolves a Country
 *    Set name (and that partner's minimum), which only means something inside
 *    one company; across several, two partners' same-named sets would merge.
 *  - **`level=theatre` needs exactly one company when — and only when — the
 *    program has TargetCountries rows.** Such a view counts those rows over the
 *    partner's own target countries (its Theatre-view Country Set inside the
 *    theatre) and applies that partner's minimum, so it is defined for one
 *    partner at a time. A program without TargetCountries rows keeps its
 *    multi-company By Theatre view exactly as before.
 *  - **A roster on such a Theatre view names its population** (`theatre` or
 *    `targetCountries`), so the list is drawn from the row's own population and
 *    matches its figure.
 *
 * The helpers would fail closed to an empty area, but that reads as an honest
 * zero, hence the 400s. Every message is fixed text: none echoes a value from
 * the request or the DB, and naming a rule discloses nothing — it depends only
 * on the caller's own scope and the program's (global) configuration.
 * Server-only (imports Prisma via `program-target-countries`).
 */

export const POPULATION_REQUIRED_ERROR =
  "A roster on a By Theatre view with target countries needs population=theatre or population=targetCountries";

export async function checkProgramViewRequest(opts: {
  programName: string;
  level: string;
  companyIds: number[] | null;
  studentsMode: boolean;
  population: string | null;
}): Promise<{ error: string } | { population: PopulationKind | null }> {
  const { level } = opts;
  const singleCompany = singleCompanyId(opts.companyIds) !== null;
  if (level === "countrySet") {
    return singleCompany ? { population: null } : { error: COUNTRY_SET_SCOPE_ERROR };
  }
  if (level !== "theatre" || !(await programHasTargetCountryRows(opts.programName))) {
    return { population: null };
  }
  if (!singleCompany) return { error: COUNTRY_SET_SCOPE_ERROR };
  const population = parsePopulationKind(opts.population);
  if (opts.studentsMode && population === null) return { error: POPULATION_REQUIRED_ERROR };
  return { population };
}
