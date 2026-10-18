/**
 * Server-side computation for the Country Coverage by Function report
 * (`/api/reports/country-coverage`, rendered at `/reports/country-coverage`).
 *
 * One row per country in the selected theatre (or region / country), carrying:
 *   - how many certifications and/or accreditations are held, split by the
 *     training's function (Sales / Pre-Sales / Deployments);
 *   - how many distinct people hold at least one, per function and overall;
 *   - the country's headcount and the resulting coverage %.
 *
 * The country list comes from Region Data, NOT from the students, so a country
 * configured in the theatre with nobody in it still appears with zeros — the
 * report exists to answer "where are we thin", and a missing row would hide the
 * thinnest country of all. `RegionData.theatre` is the source of truth for a
 * country's theatre (CLAUDE.md), which is why the theatre filter is applied to
 * Region Data rather than to the denormalised `Student.theatre`.
 *
 * Counting rules, matching the dashboard:
 *   - completions are deduped to the most recent per (email, fullTitle,
 *     trainingType), so one person re-sitting a cert counts it once;
 *   - unreviewed and ignored catalogue rows never count (reportable-training.ts);
 *   - by default only ACTIVE (expiryDate > now) completions count, applied after
 *     the dedupe; `includeInactive` adds expired ones back.
 *
 * Subtotals: a student has exactly one `country`, so the distinct-people sets
 * of different countries are disjoint and per-country people counts can be
 * summed into theatre and grand totals without double counting. If a student
 * ever gains several countries that stops being true.
 */

import prisma from "@/lib/prisma";
import type { Prisma, TrainingType } from "@prisma/client";
import { ELIGIBLE_TRAINING_DATA } from "@/lib/reportable-training";

// ─── Types ──────────────────────────────────────────────────────────────────────

export type CoverageTypeFilter = "all" | "cert" | "accred";

export const COVERAGE_TYPE_FILTERS: CoverageTypeFilter[] = ["all", "cert", "accred"];

export function parseCoverageTypeFilter(v: string | null | undefined): CoverageTypeFilter {
  return v === "cert" || v === "accred" ? v : "all";
}

const TYPES_FOR_FILTER: Record<CoverageTypeFilter, TrainingType[]> = {
  all: ["Certification", "Accreditation"],
  cert: ["Certification"],
  accred: ["Accreditation"],
};

/** The function columns, keyed by the `FunctionType` enum value. */
export const COVERAGE_FUNCTIONS = ["Sales", "PreSales", "Deployments"] as const;
export type CoverageFunction = (typeof COVERAGE_FUNCTIONS)[number];

export interface CoverageCounts {
  headcount: number;
  sales: number;
  preSales: number;
  deployments: number;
  total: number;
  peopleSales: number;
  peoplePreSales: number;
  peopleDeployments: number;
  /** Distinct people holding at least one counted cert/accred, any function. */
  people: number;
  /** people / headcount × 100, or null when the headcount is zero. */
  coverage: number | null;
}

export interface CoverageRow extends CoverageCounts {
  country: string;
  region: string;
  /** Empty string when Region Data has no theatre for the country. */
  theatre: string;
}

export interface CoverageGroup extends CoverageCounts {
  theatre: string;
  countries: number;
}

export interface CountryCoverageInput {
  companyIds: number[] | null;
  theatre?: string;
  region?: string;
  country?: string;
  /**
   * Restrict to countries Region Data gives no theatre. Only the drill-down
   * behind the "No theatre" subtotal sets it; `theatre` is ignored when true.
   */
  noTheatre?: boolean;
  type?: CoverageTypeFilter;
  includeInactive?: boolean;
}

export interface CountryCoverageResult {
  rows: CoverageRow[];
  groups: CoverageGroup[];
  totals: CoverageCounts & { countries: number };
}

const FUNCTION_FIELD: Record<CoverageFunction, { count: "sales" | "preSales" | "deployments"; people: "peopleSales" | "peoplePreSales" | "peopleDeployments" }> = {
  Sales: { count: "sales", people: "peopleSales" },
  PreSales: { count: "preSales", people: "peoplePreSales" },
  Deployments: { count: "deployments", people: "peopleDeployments" },
};

function emptyCounts(): CoverageCounts {
  return {
    headcount: 0,
    sales: 0,
    preSales: 0,
    deployments: 0,
    total: 0,
    peopleSales: 0,
    peoplePreSales: 0,
    peopleDeployments: 0,
    people: 0,
    coverage: null,
  };
}

function coveragePct(people: number, headcount: number): number | null {
  return headcount > 0 ? Math.round((people / headcount) * 1000) / 10 : null;
}

export function emptyCountryCoverage(): CountryCoverageResult {
  return { rows: [], groups: [], totals: { ...emptyCounts(), countries: 0 } };
}

// ─── Fetch + compute ─────────────────────────────────────────────────────────────

export interface CoverageCountryInput {
  country: string;
  region: string;
  theatre: string | null;
}

export interface CoverageCompletionInput {
  email: string;
  country: string;
  fullTitle: string;
  trainingType: string;
  function: string;
  completedDate: Date;
  expiryDate: Date;
}

interface CoverageInputs {
  countries: CoverageCountryInput[];
  studentWhere: Prisma.StudentWhereInput;
  headcountByCountry: Map<string, number>;
  completions: CoverageCompletionInput[];
}

/**
 * The one fetch behind both the report and its drill-down, so a figure and the
 * list it opens are always built from the same countries, students and
 * completions. Returns null when no Region Data country is in scope.
 */
async function loadCoverageInputs(input: CountryCoverageInput): Promise<CoverageInputs | null> {
  const { companyIds, theatre = "", region = "", country = "", type = "all", noTheatre = false } = input;

  const countries = await prisma.regionData.findMany({
    where: {
      ...(noTheatre ? { theatre: null } : theatre ? { theatre } : {}),
      ...(region ? { region } : {}),
      ...(country ? { country } : {}),
    },
    select: { country: true, region: true, theatre: true },
  });
  if (countries.length === 0) return null;

  const countryNames = countries.map((c) => c.country);
  // `ids ? … : {}` rather than a length test: an empty array must match nothing.
  const studentWhere: Prisma.StudentWhereInput = {
    country: { in: countryNames },
    ...(companyIds ? { companyId: { in: companyIds } } : {}),
  };

  const [headcounts, completions] = await Promise.all([
    prisma.student.groupBy({ by: ["country"], where: studentWhere, _count: { _all: true } }),
    prisma.trainingTaken.findMany({
      where: {
        trainingData: { ...ELIGIBLE_TRAINING_DATA, trainingType: { in: TYPES_FOR_FILTER[type] } },
        student: studentWhere,
      },
      select: {
        email: true,
        completedDate: true,
        expiryDate: true,
        student: { select: { country: true } },
        trainingData: { select: { fullTitle: true, trainingType: true, function: true } },
      },
    }),
  ]);

  return {
    countries,
    studentWhere,
    headcountByCountry: new Map(headcounts.map((h) => [h.country, h._count._all])),
    completions: completions.map((c) => ({
      email: c.email,
      country: c.student.country,
      fullTitle: c.trainingData.fullTitle,
      trainingType: c.trainingData.trainingType,
      function: c.trainingData.function,
      completedDate: c.completedDate,
      expiryDate: c.expiryDate,
    })),
  };
}

export async function computeCountryCoverage(input: CountryCoverageInput): Promise<CountryCoverageResult> {
  const inputs = await loadCoverageInputs(input);
  if (!inputs) return emptyCountryCoverage();
  return computeFromInputs(
    inputs.countries,
    inputs.headcountByCountry,
    inputs.completions,
    input.includeInactive ?? false,
  );
}

/**
 * The completions that count towards the figures: the most recent per
 * (email, fullTitle, trainingType), active unless `includeInactive`, and with a
 * function that has a column. Shared by the aggregation and the drill-down —
 * if the two applied different rules, a figure would open a list of a
 * different length.
 */
function countedCompletions(
  completions: CoverageCompletionInput[],
  includeInactive: boolean,
  now: Date,
): CoverageCompletionInput[] {
  const latest = new Map<string, CoverageCompletionInput>();
  for (const c of completions) {
    const key = `${c.email}::${c.fullTitle}::${c.trainingType}`;
    const existing = latest.get(key);
    if (!existing || c.completedDate > existing.completedDate) latest.set(key, c);
  }
  return [...latest.values()].filter(
    (c) =>
      (includeInactive || c.expiryDate > now) &&
      (COVERAGE_FUNCTIONS as readonly string[]).includes(c.function),
  );
}

/**
 * Pure aggregation over already-fetched inputs, split from the fetch so it can
 * be exercised without a database. `now` is injectable for the same reason.
 */
export function computeFromInputs(
  countries: CoverageCountryInput[],
  headcountByCountry: Map<string, number>,
  completions: CoverageCompletionInput[],
  includeInactive: boolean,
  now: Date = new Date(),
): CountryCoverageResult {
  interface Acc {
    counts: Record<CoverageFunction, number>;
    people: Record<CoverageFunction, Set<string>>;
    any: Set<string>;
  }
  const accs = new Map<string, Acc>();
  const accFor = (country: string): Acc => {
    let acc = accs.get(country);
    if (!acc) {
      acc = {
        counts: { Sales: 0, PreSales: 0, Deployments: 0 },
        people: { Sales: new Set(), PreSales: new Set(), Deployments: new Set() },
        any: new Set(),
      };
      accs.set(country, acc);
    }
    return acc;
  };

  for (const c of countedCompletions(completions, includeInactive, now)) {
    const fn = c.function as CoverageFunction;
    const acc = accFor(c.country);
    acc.counts[fn] += 1;
    acc.people[fn].add(c.email);
    acc.any.add(c.email);
  }

  const rows: CoverageRow[] = countries.map((c) => {
    const acc = accs.get(c.country);
    const row: CoverageRow = {
      ...emptyCounts(),
      country: c.country,
      region: c.region,
      theatre: c.theatre ?? "",
      headcount: headcountByCountry.get(c.country) ?? 0,
    };
    if (acc) {
      for (const fn of COVERAGE_FUNCTIONS) {
        const f = FUNCTION_FIELD[fn];
        row[f.count] = acc.counts[fn];
        row[f.people] = acc.people[fn].size;
      }
      row.total = row.sales + row.preSales + row.deployments;
      row.people = acc.any.size;
    }
    row.coverage = coveragePct(row.people, row.headcount);
    return row;
  });
  rows.sort((a, b) => a.country.localeCompare(b.country));

  const sum = (target: CoverageCounts, r: CoverageCounts) => {
    target.headcount += r.headcount;
    target.sales += r.sales;
    target.preSales += r.preSales;
    target.deployments += r.deployments;
    target.total += r.total;
    target.peopleSales += r.peopleSales;
    target.peoplePreSales += r.peoplePreSales;
    target.peopleDeployments += r.peopleDeployments;
    target.people += r.people;
  };

  const groupMap = new Map<string, CoverageGroup>();
  const totals = { ...emptyCounts(), countries: rows.length };
  for (const r of rows) {
    let g = groupMap.get(r.theatre);
    if (!g) {
      g = { ...emptyCounts(), theatre: r.theatre, countries: 0 };
      groupMap.set(r.theatre, g);
    }
    g.countries += 1;
    sum(g, r);
    sum(totals, r);
  }
  const groups = [...groupMap.values()]
    .map((g) => ({ ...g, coverage: coveragePct(g.people, g.headcount) }))
    // Countries with no theatre sort last.
    .sort((a, b) => (a.theatre === "" ? 1 : b.theatre === "" ? -1 : a.theatre.localeCompare(b.theatre)));
  totals.coverage = coveragePct(totals.people, totals.headcount);

  return { rows, groups, totals };
}

// ─── Drill-down: the people or records behind one figure ────────────────────────

/** Which figure was clicked: the headcount, a "people holding" or a "held" cell. */
export type CoverageMetric = "headcount" | "people" | "held";
export const COVERAGE_METRICS: CoverageMetric[] = ["headcount", "people", "held"];
/** A function column, or "all" for the Total / Any columns. */
export type CoverageFunctionFilter = CoverageFunction | "all";

export function parseCoverageMetric(v: string | null | undefined): CoverageMetric | null {
  return COVERAGE_METRICS.includes(v as CoverageMetric) ? (v as CoverageMetric) : null;
}

export function parseCoverageFunction(v: string | null | undefined): CoverageFunctionFilter {
  return (COVERAGE_FUNCTIONS as readonly string[]).includes(v ?? "") ? (v as CoverageFunction) : "all";
}

const FUNCTION_LABELS: Record<CoverageFunction, string> = {
  Sales: "Sales",
  PreSales: "Pre-Sales",
  Deployments: "Deployments",
};

export interface CoverageStudentRow {
  fullName: string;
  email: string;
  country: string;
  /** Counted certs/accreds this person holds within the clicked function. */
  held: number;
  trainings: string[];
}

export interface CoverageRecordRow {
  fullName: string;
  email: string;
  country: string;
  training: string;
  trainingType: string;
  function: string;
  completedDate: string;
  expiryDate: string;
  active: boolean;
}

export type CoverageDrilldown =
  | { kind: "students"; rows: CoverageStudentRow[] }
  | { kind: "records"; rows: CoverageRecordRow[] };

/**
 * The list behind one figure, built from the same inputs and the same
 * `countedCompletions` rule, so its length is the figure that was clicked:
 * `headcount` lists every student in scope, `people` the distinct holders in
 * the function, `held` one row per counted cert/accred.
 */
export async function computeCountryCoverageDrilldown(
  input: CountryCoverageInput & { metric: CoverageMetric; fn: CoverageFunctionFilter },
  now: Date = new Date(),
): Promise<CoverageDrilldown> {
  const inputs = await loadCoverageInputs(input);
  if (!inputs) return input.metric === "held" ? { kind: "records", rows: [] } : { kind: "students", rows: [] };

  const students = await prisma.student.findMany({
    where: inputs.studentWhere,
    select: { email: true, fullName: true, country: true },
  });
  const byEmail = new Map(students.map((s) => [s.email, s]));

  const counted = countedCompletions(inputs.completions, input.includeInactive ?? false, now).filter(
    (c) => input.fn === "all" || c.function === input.fn,
  );

  if (input.metric === "held") {
    return {
      kind: "records",
      rows: counted.map((c) => ({
        fullName: byEmail.get(c.email)?.fullName ?? c.email,
        email: c.email,
        country: c.country,
        training: c.fullTitle,
        trainingType: c.trainingType,
        function: FUNCTION_LABELS[c.function as CoverageFunction],
        completedDate: c.completedDate.toISOString(),
        expiryDate: c.expiryDate.toISOString(),
        active: c.expiryDate > now,
      })),
    };
  }

  const holdings = new Map<string, string[]>();
  for (const c of counted) {
    const list = holdings.get(c.email) ?? [];
    list.push(c.fullTitle);
    holdings.set(c.email, list);
  }
  const listed = input.metric === "headcount" ? students : students.filter((s) => holdings.has(s.email));
  return {
    kind: "students",
    rows: listed.map((s) => {
      const trainings = holdings.get(s.email) ?? [];
      return {
        fullName: s.fullName,
        email: s.email,
        country: s.country,
        held: trainings.length,
        trainings: [...new Set(trainings)].sort((a, b) => a.localeCompare(b)),
      };
    }),
  };
}

const STUDENT_SORT_KEYS = ["fullName", "email", "country", "held"] as const;
const RECORD_SORT_KEYS = [
  "fullName", "email", "country", "training", "trainingType", "function", "completedDate", "expiryDate",
] as const;

/** The sort keys a drill-down of this kind accepts; anything else falls back. */
export function drilldownSortKeys(kind: CoverageDrilldown["kind"]): readonly string[] {
  return kind === "records" ? RECORD_SORT_KEYS : STUDENT_SORT_KEYS;
}

/**
 * Sorted copy of a drill-down's rows (the cached value is shared, so it is
 * never sorted in place). Ties fall back to name then email so paging is total.
 */
export function sortDrilldown(
  data: CoverageDrilldown,
  sortKey: string,
  sortDir: "asc" | "desc",
): CoverageDrilldown["rows"] {
  const key = drilldownSortKeys(data.kind).includes(sortKey) ? sortKey : "fullName";
  const dir = sortDir === "desc" ? -1 : 1;
  const value = (r: CoverageStudentRow | CoverageRecordRow): string | number =>
    (r as unknown as Record<string, string | number>)[key];
  const rows = [...data.rows] as (CoverageStudentRow | CoverageRecordRow)[];
  rows.sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    const primary =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true });
    if (primary !== 0) return primary * dir;
    return a.fullName.localeCompare(b.fullName) || a.email.localeCompare(b.email);
  });
  return rows as CoverageDrilldown["rows"];
}
