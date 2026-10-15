import { prisma } from "@/lib/prisma";
import { countriesInCountrySet, singleCompanyId } from "@/lib/country-sets";
import type { ComplianceScope } from "@/lib/program-compliance";
import type { AnchoredMeta, MinimumCountriesSource } from "@/lib/program-levels";

/**
 * The server half of **anchored programs** — the shared resolver every surface
 * (program dashboard, Compliance Planning, public API) goes through, so they
 * cannot disagree about which countries, which theatre or whose minimum a view
 * is over. The vocabulary (levels, `AnchoredMeta`, `isProgramWideRow`) lives in
 * the import-free `program-levels.ts`.
 *
 * An anchored program (`Program.anchorTheatre` set) is judged over two
 * populations at once:
 *  - its **Theatre** rows over the anchor theatre (`Student.theatre`), and
 *  - its **CountrySet** rows over the partner's **target countries** — the
 *    members of the chosen Country Set that lie inside the anchor theatre.
 *
 * Members outside the anchor theatre are excluded from the target population
 * and from the minimum count, and returned as `outOfTheatreCountries` so the
 * page can name them rather than drop them silently.
 *
 * A partner's terms come from `ProgramCompanySetting` (minimum countries + the
 * set holding its targets), falling back to `Program.defaultMinimumCountries`.
 * Like a Country Set, they only mean something for exactly ONE company, so an
 * anchored view is single-company only (`resolveAnchoredArea` answers
 * `{ error: "scope" }` otherwise; routes turn that into
 * `COUNTRY_SET_SCOPE_ERROR`, a 400).
 *
 * Server-only — imports Prisma.
 */

export interface ProgramAnchorRow {
  id: number;
  name: string;
  anchorTheatre: string | null;
  defaultMinimumCountries: number | null;
}

/** The program's anchor settings, or null when the program does not exist. */
export async function getProgramAnchor(programName: string): Promise<ProgramAnchorRow | null> {
  return prisma.program.findUnique({
    where: { name: programName },
    select: { id: true, name: true, anchorTheatre: true, defaultMinimumCountries: true },
  });
}

/** Whether a program row is anchored (has a non-blank anchor theatre). */
export function isAnchoredProgram(p: { anchorTheatre: string | null } | null | undefined): boolean {
  return !!p && typeof p.anchorTheatre === "string" && p.anchorTheatre.trim() !== "";
}

export interface PartnerTerms {
  minimumCountries: number | null;
  minimumCountriesSource: MinimumCountriesSource;
  /** Name of the partner's configured target Country Set, if any. */
  targetCountrySet: string | null;
}

/**
 * One partner's effective terms for a program: its own minimum if set, else the
 * program default, else none. The target set is returned only when it belongs
 * to the same company (defence in depth — the write path enforces it too).
 */
export async function resolvePartnerTerms(
  program: Pick<ProgramAnchorRow, "id" | "defaultMinimumCountries">,
  companyId: number
): Promise<PartnerTerms> {
  const setting = await prisma.programCompanySetting.findUnique({
    where: { programId_companyId: { programId: program.id, companyId } },
    select: {
      minimumCountries: true,
      targetCountrySet: { select: { name: true, companyId: true } },
    },
  });
  const targetCountrySet =
    setting?.targetCountrySet && setting.targetCountrySet.companyId === companyId
      ? setting.targetCountrySet.name
      : null;
  if (setting?.minimumCountries != null) {
    return { minimumCountries: setting.minimumCountries, minimumCountriesSource: "partner", targetCountrySet };
  }
  if (program.defaultMinimumCountries != null) {
    return { minimumCountries: program.defaultMinimumCountries, minimumCountriesSource: "default", targetCountrySet };
  }
  return { minimumCountries: null, minimumCountriesSource: "none", targetCountrySet };
}

export interface AnchoredArea {
  companyId: number;
  meta: AnchoredMeta;
  /** Population for Theatre-level rows. */
  theatreScope: ComplianceScope;
  /** Population for CountrySet-level rows (the target countries; `[]` = nobody). */
  targetScope: ComplianceScope;
  /**
   * Stable population keys for Compliance Planning's `populationKey`. The
   * target key carries the company for the same reason a Country Set's does:
   * two companies' same-named sets are different populations.
   */
  theatrePopulationKey: string;
  targetPopulationKey: string;
}

/**
 * Resolve an anchored view for one company.
 *
 * `countrySet` is the set the caller asked for; when null/blank it defaults to
 * the partner's configured target set. A set the company does not own resolves
 * to no countries (an empty, never-met area), exactly as
 * `countriesInCountrySet` already behaves. With no set at all, `meta.countrySet`
 * is null and the target population is empty.
 */
export async function resolveAnchoredArea(opts: {
  program: ProgramAnchorRow;
  countrySet: string | null | undefined;
  companyIds: number[] | null;
}): Promise<AnchoredArea | { error: "scope" } | { error: "notAnchored" }> {
  const { program, companyIds } = opts;
  if (!isAnchoredProgram(program)) return { error: "notAnchored" };
  const companyId = singleCompanyId(companyIds);
  if (companyId == null) return { error: "scope" };
  const anchorTheatre = program.anchorTheatre!.trim();

  const terms = await resolvePartnerTerms(program, companyId);
  const requested = typeof opts.countrySet === "string" && opts.countrySet.trim() !== "" ? opts.countrySet.trim() : null;
  const countrySet = requested ?? terms.targetCountrySet;

  const members = countrySet ? await countriesInCountrySet(countrySet, [companyId]) : [];
  const theatreRows = members.length
    ? await prisma.regionData.findMany({ where: { country: { in: members } }, select: { country: true, theatre: true } })
    : [];
  const theatreOf = new Map(theatreRows.map((r) => [r.country, r.theatre]));
  const targetCountries = members.filter((c) => theatreOf.get(c) === anchorTheatre).sort((a, b) => a.localeCompare(b));
  const outOfTheatreCountries = members.filter((c) => theatreOf.get(c) !== anchorTheatre).sort((a, b) => a.localeCompare(b));

  const minimumMet = terms.minimumCountries == null || targetCountries.length >= terms.minimumCountries;

  return {
    companyId,
    meta: {
      anchorTheatre,
      countrySet,
      targetCountries,
      outOfTheatreCountries,
      minimumCountries: terms.minimumCountries,
      minimumCountriesSource: terms.minimumCountriesSource,
      minimumMet,
    },
    theatreScope: { theatre: anchorTheatre, companyIds: [companyId] },
    // An empty list is `in: []`, i.e. nobody — never the whole world.
    targetScope: { countries: targetCountries, companyIds: [companyId] },
    theatrePopulationKey: `theatre:${anchorTheatre}`,
    targetPopulationKey: `anchoredTargets:${companyId}:${countrySet ?? ""}`,
  };
}
