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

export async function computeCountryCoverage(input: CountryCoverageInput): Promise<CountryCoverageResult> {
  const { companyIds, theatre = "", region = "", country = "", type = "all" } = input;

  const countries = await prisma.regionData.findMany({
    where: {
      ...(theatre ? { theatre } : {}),
      ...(region ? { region } : {}),
      ...(country ? { country } : {}),
    },
    select: { country: true, region: true, theatre: true },
  });
  if (countries.length === 0) return emptyCountryCoverage();

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

  const headcountByCountry = new Map(headcounts.map((h) => [h.country, h._count._all]));
  return computeFromInputs(
    countries,
    headcountByCountry,
    completions.map((c) => ({
      email: c.email,
      country: c.student.country,
      fullTitle: c.trainingData.fullTitle,
      trainingType: c.trainingData.trainingType,
      function: c.trainingData.function,
      completedDate: c.completedDate,
      expiryDate: c.expiryDate,
    })),
    input.includeInactive ?? false,
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
  // Most recent completion per (email, fullTitle, trainingType).
  const latest = new Map<string, CoverageCompletionInput>();
  for (const c of completions) {
    const key = `${c.email}::${c.fullTitle}::${c.trainingType}`;
    const existing = latest.get(key);
    if (!existing || c.completedDate > existing.completedDate) latest.set(key, c);
  }

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

  for (const c of latest.values()) {
    if (!includeInactive && !(c.expiryDate > now)) continue;
    if (!(COVERAGE_FUNCTIONS as readonly string[]).includes(c.function)) continue;
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
