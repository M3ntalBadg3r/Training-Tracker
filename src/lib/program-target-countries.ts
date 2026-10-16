import { prisma } from "@/lib/prisma";
import { countriesInCountrySet, singleCompanyId } from "@/lib/country-sets";
import type { ComplianceScope } from "@/lib/program-compliance";
import type {
  CountrySetMinimumMeta,
  MinimumCountriesSource,
  MinimumView,
  TargetCountriesMeta,
} from "@/lib/program-levels";

/**
 * The server half of **target countries and per-view minimums** — the shared
 * resolver every surface (program dashboard, Compliance Planning, public API)
 * goes through, so they cannot disagree about which countries a view is over
 * or whose minimum applies. The vocabulary (`TargetCountriesMeta`,
 * `CountrySetMinimumMeta`, `isProgramWideRow`) lives in the import-free
 * `program-levels.ts`.
 *
 * - **By Theatre** of a program with `TargetCountries` rows is judged over two
 *   populations at once: its Theatre rows over the theatre being viewed
 *   (`Student.theatre`), and its TargetCountries rows over the partner's
 *   **target countries** — the members of the partner's Theatre-view Country
 *   Set that lie inside that theatre. Members outside it are excluded from the
 *   target population and the minimum count, and returned as
 *   `outOfTheatreCountries` so the page can name them.
 * - **By Country Set** checks the viewed set's member count against the
 *   partner's Country Set-view minimum.
 *
 * A partner's terms come from `ProgramCompanySetting` — separately for each
 * view — falling back to the program's per-view default. Like a Country Set,
 * they only mean something for exactly ONE company, so both resolvers answer
 * `{ error: "scope" }` for any other scope; routes turn that into
 * `COUNTRY_SET_SCOPE_ERROR`, a 400.
 *
 * Server-only — imports Prisma.
 */

/**
 * The 400 for a By Theatre view (report, roster or plan) of a program with
 * TargetCountries rows whose scope is not exactly one company. Its own message,
 * not `COUNTRY_SET_SCOPE_ERROR`: the request names a theatre, and being told to
 * pick a company "to report on a Country Set" would not explain itself.
 */
export const TARGET_COUNTRIES_SCOPE_ERROR =
  "Select a single company to report on a By Theatre view with target countries";

export interface ProgramTermsRow {
  id: number;
  name: string;
  countrySetMinimumCountries: number | null;
  targetMinimumCountries: number | null;
}

/** The program's per-view default minimums, or null when the program does not exist. */
export async function getProgramTerms(programName: string): Promise<ProgramTermsRow | null> {
  return prisma.program.findUnique({
    where: { name: programName },
    select: { id: true, name: true, countrySetMinimumCountries: true, targetMinimumCountries: true },
  });
}

/** Whether a program has any TargetCountries requirement rows (so its Theatre view uses target countries). */
export async function programHasTargetCountryRows(programName: string): Promise<boolean> {
  const row = await prisma.programData.findFirst({
    where: { programName, level: "TargetCountries" },
    select: { id: true },
  });
  return row !== null;
}

/** One view's effective terms for one partner. */
export interface ViewTerms {
  minimumCountries: number | null;
  minimumCountriesSource: MinimumCountriesSource;
  /** Name of the partner's configured Country Set for this view, if any. */
  countrySet: string | null;
}

export interface PartnerTerms {
  countrySet: ViewTerms;
  theatre: ViewTerms;
}

function effectiveMinimum(own: number | null | undefined, fallback: number | null): Pick<ViewTerms, "minimumCountries" | "minimumCountriesSource"> {
  if (own != null) return { minimumCountries: own, minimumCountriesSource: "partner" };
  if (fallback != null) return { minimumCountries: fallback, minimumCountriesSource: "default" };
  return { minimumCountries: null, minimumCountriesSource: "none" };
}

/**
 * One partner's effective terms for a program, per view: its own minimum if
 * set, else the program default, else none. A configured set is returned only
 * when it belongs to the same company (defence in depth — the write path
 * enforces it too).
 */
export async function resolvePartnerTerms(
  program: Pick<ProgramTermsRow, "id" | "countrySetMinimumCountries" | "targetMinimumCountries">,
  companyId: number
): Promise<PartnerTerms> {
  const setting = await prisma.programCompanySetting.findUnique({
    where: { programId_companyId: { programId: program.id, companyId } },
    select: {
      countrySetMinimumCountries: true,
      targetMinimumCountries: true,
      countrySet: { select: { name: true, companyId: true } },
      targetCountrySet: { select: { name: true, companyId: true } },
    },
  });
  const ownSet = (s: { name: string; companyId: number } | null | undefined) =>
    s && s.companyId === companyId ? s.name : null;
  return {
    countrySet: {
      ...effectiveMinimum(setting?.countrySetMinimumCountries, program.countrySetMinimumCountries),
      countrySet: ownSet(setting?.countrySet),
    },
    theatre: {
      ...effectiveMinimum(setting?.targetMinimumCountries, program.targetMinimumCountries),
      countrySet: ownSet(setting?.targetCountrySet),
    },
  };
}

/** Which view's terms to read. */
export function termsFor(terms: PartnerTerms, view: MinimumView): ViewTerms {
  return view === "countrySet" ? terms.countrySet : terms.theatre;
}

function requestedSet(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export interface TargetArea {
  companyId: number;
  meta: TargetCountriesMeta;
  /** Population for Theatre rows. */
  theatreScope: ComplianceScope;
  /** Population for TargetCountries rows (the target countries; `[]` = nobody). */
  targetScope: ComplianceScope;
  /**
   * Stable population keys for Compliance Planning's `populationKey`. The
   * target key carries the company for the same reason a Country Set's does:
   * two companies' same-named sets are different populations — and the theatre,
   * because the same set yields different targets in different theatres.
   */
  theatrePopulationKey: string;
  targetPopulationKey: string;
}

/**
 * Resolve a By Theatre view's target countries for one company.
 *
 * `countrySet` is the set the caller asked for; when null/blank it defaults to
 * the partner's configured Theatre-view set. A set the company does not own
 * resolves to no countries (an empty, never-met area), exactly as
 * `countriesInCountrySet` already behaves. With no set at all,
 * `meta.countrySet` is null and the target population is empty.
 */
export async function resolveTargetArea(opts: {
  program: ProgramTermsRow;
  theatre: string;
  countrySet: string | null | undefined;
  companyIds: number[] | null;
}): Promise<TargetArea | { error: "scope" }> {
  const { program, companyIds } = opts;
  const companyId = singleCompanyId(companyIds);
  if (companyId == null) return { error: "scope" };
  const theatre = opts.theatre.trim();

  const terms = (await resolvePartnerTerms(program, companyId)).theatre;
  const countrySet = requestedSet(opts.countrySet) ?? terms.countrySet;

  const members = countrySet ? await countriesInCountrySet(countrySet, [companyId]) : [];
  const theatreRows = members.length
    ? await prisma.regionData.findMany({ where: { country: { in: members } }, select: { country: true, theatre: true } })
    : [];
  const theatreOf = new Map(theatreRows.map((r) => [r.country, r.theatre]));
  const targetCountries = members.filter((c) => theatreOf.get(c) === theatre).sort((a, b) => a.localeCompare(b));
  const outOfTheatreCountries = members.filter((c) => theatreOf.get(c) !== theatre).sort((a, b) => a.localeCompare(b));

  const minimumMet = terms.minimumCountries == null || targetCountries.length >= terms.minimumCountries;

  return {
    companyId,
    meta: {
      theatre,
      countrySet,
      targetCountries,
      outOfTheatreCountries,
      minimumCountries: terms.minimumCountries,
      minimumCountriesSource: terms.minimumCountriesSource,
      minimumMet,
    },
    theatreScope: { theatre, companyIds: [companyId] },
    // An empty list is `in: []`, i.e. nobody — never the whole world.
    targetScope: { countries: targetCountries, companyIds: [companyId] },
    theatrePopulationKey: `theatre:${theatre}`,
    targetPopulationKey: `targetCountries:${companyId}:${theatre}:${countrySet ?? ""}`,
  };
}

/**
 * Resolve a By Country Set view's set and minimum for one company.
 *
 * `countrySet` is the set the caller asked for; when null/blank it defaults to
 * the partner's configured Country Set-view set (null when there is none —
 * the caller then has no set to report on). `countries` are the set's members
 * (`[]` for a set the company does not own).
 */
export async function resolveCountrySetMinimum(opts: {
  program: ProgramTermsRow;
  countrySet: string | null | undefined;
  companyIds: number[] | null;
}): Promise<{ companyId: number; meta: CountrySetMinimumMeta } | { error: "scope" }> {
  const companyId = singleCompanyId(opts.companyIds);
  if (companyId == null) return { error: "scope" };
  const terms = (await resolvePartnerTerms(opts.program, companyId)).countrySet;
  const countrySet = requestedSet(opts.countrySet) ?? terms.countrySet;
  const countries = countrySet ? await countriesInCountrySet(countrySet, [companyId]) : [];
  return {
    companyId,
    meta: {
      countrySet,
      countries,
      minimumCountries: terms.minimumCountries,
      minimumCountriesSource: terms.minimumCountriesSource,
      minimumMet: terms.minimumCountries == null || countries.length >= terms.minimumCountries,
    },
  };
}
