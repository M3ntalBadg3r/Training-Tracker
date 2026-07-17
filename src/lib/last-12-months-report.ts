/**
 * Server-side computation for the Achievement Over Time report
 * (`/api/reports/last-12-months`, rendered at `/reports/last-12-months`).
 *
 * The report used to ship the entire `/api/reports/training-records` dataset to
 * the browser and filter/aggregate/render it client-side (a time-series chart
 * with dynamic granularity + prior-period comparison, a Top-10 trainings list,
 * KPIs, and every row via GroupedRows with no pagination). This module moves
 * that work to the server so the browser downloads only a small summary plus one
 * page of rows.
 *
 * Parity: a faithful move of the old client code — same window resolution,
 * granularity (day/week/month) heuristic, bucket axis, this-vs-prior chart
 * series, Top-10, KPIs, `filtered` predicate, sort and grouping. Only the detail
 * table is paginated.
 */

import { groupRows, type GroupByMode } from "@/lib/group-by";
import { fetchDedupedTrainingRecords, type DedupedTrainingRecord } from "@/lib/training-records-query";

// ─── Date helpers (mirror the page) ─────────────────────────────────────────────

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function weekStart(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay();
  const diff = (day + 6) % 7; // Monday-start week
  x.setDate(x.getDate() - diff);
  return x;
}
function weekKey(d: Date): string {
  return dayKey(weekStart(d));
}

export type Granularity = "day" | "week" | "month";
export type RangePreset = "12m" | "6m" | "3m" | "1m" | "custom";

const RANGE_MONTHS: Record<Exclude<RangePreset, "custom">, number> = { "12m": 12, "6m": 6, "3m": 3, "1m": 1 };

// ─── Types ──────────────────────────────────────────────────────────────────────

export type AchievementRow = DedupedTrainingRecord;

export interface LastTwelveMonthsInput {
  companyIds: number[] | null;
  search?: string;
  type?: string;
  theatre?: string;
  region?: string;
  country?: string;
  function?: string;
  product?: string;
  bucket?: string | null;
  rangePreset?: RangePreset;
  customFrom?: string | null;
  customTo?: string | null;
  groupBy?: GroupByMode | null;
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  all?: boolean;
}

export interface LastTwelveMonthsResult {
  charts: {
    chartData: { bucketKey: string; label: string; "This period": number; "Prior period": number }[];
    topTitles: { title: string; count: number; productType: string }[];
    granularity: Granularity;
  };
  kpis: { total: number; cert: number; accred: number; ilt: number; olx: number; thisPeriodTotal: number; priorPeriodTotal: number; change: number };
  groups: { key: string; total: number }[];
  rows: AchievementRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: { types: string[]; functions: string[]; products: string[] };
}

// ─── Sort (mirrors hooks/useTableSort compare semantics) ────────────────────────

type SortValue = string | number | boolean | null | undefined;

function isEmpty(v: SortValue): boolean {
  return v === null || v === undefined || v === "";
}

function compare(a: SortValue, b: SortValue): number {
  const ae = isEmpty(a);
  const be = isEmpty(b);
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" || typeof b === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

const SORT_ACCESSORS: Record<string, (r: AchievementRow) => SortValue> = {
  fullName: (r) => r.fullName,
  email: (r) => r.email,
  theatre: (r) => r.theatre,
  region: (r) => r.region,
  country: (r) => r.country,
  trainingTitle: (r) => r.trainingTitle,
  trainingType: (r) => r.trainingType,
  productType: (r) => r.productType,
  function: (r) => r.function,
  completedDate: (r) => r.completedDate,
  expiryDate: (r) => r.expiryDate,
  active: (r) => r.active,
};

// ─── Main compute ────────────────────────────────────────────────────────────────

export async function computeLastTwelveMonths(input: LastTwelveMonthsInput): Promise<LastTwelveMonthsResult> {
  const records = await fetchDedupedTrainingRecords(input.companyIds);
  return computeFromRecords(records, input);
}

export function computeFromRecords(
  records: AchievementRow[],
  input: Omit<LastTwelveMonthsInput, "companyIds">,
  now: Date = new Date(),
): LastTwelveMonthsResult {
  const {
    search = "",
    type = "",
    theatre = "",
    region = "",
    country = "",
    function: fn = "",
    product = "",
    bucket = null,
    rangePreset = "12m",
    customFrom = null,
    customTo = null,
    groupBy = null,
    sortColumn = "fullName",
    sortDir = "asc",
    all = false,
  } = input;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, input.pageSize ?? 25);

  const filterOptions = {
    types: [...new Set(records.map((r) => r.trainingType))].filter(Boolean).sort(),
    functions: [...new Set(records.map((r) => r.function))].filter(Boolean).sort(),
    products: [...new Set(records.map((r) => r.productType))].filter(Boolean).sort(),
  };

  // Resolve current window. Null from/to mean "no constraint" (matches the page).
  let windowStart: Date;
  let windowEnd: Date;
  let isAllTime: boolean;
  if (rangePreset === "custom") {
    const noFrom = !customFrom;
    windowStart = customFrom ? startOfDay(new Date(customFrom)) : new Date(0);
    windowEnd = customTo ? endOfDay(new Date(customTo)) : endOfDay(now);
    isAllTime = noFrom;
  } else {
    const months = RANGE_MONTHS[rangePreset] ?? 12;
    const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    windowStart = startOfDay(start);
    windowEnd = endOfDay(now);
    isAllTime = false;
  }

  // Earliest completion — used to tighten the axis under "All time".
  let earliestCompleted: Date | null = null;
  {
    let min: number | null = null;
    for (const r of records) {
      const t = new Date(r.completedDate).getTime();
      if (Number.isFinite(t) && (min === null || t < min)) min = t;
    }
    earliestCompleted = min === null ? null : new Date(min);
  }
  const axisStart = isAllTime && earliestCompleted ? startOfDay(earliestCompleted) : windowStart;

  // Prior window — same length immediately before windowStart.
  const lenMs = windowEnd.getTime() - windowStart.getTime();
  const priorEnd = new Date(windowStart.getTime() - 1);
  const priorStart = new Date(priorEnd.getTime() - lenMs);

  // Granularity from the visible axis span.
  const days = Math.max(1, Math.round((windowEnd.getTime() - axisStart.getTime()) / 86400000));
  const granularity: Granularity = days <= 35 ? "day" : days <= 100 ? "week" : "month";
  const bucketKey = granularity === "day" ? dayKey : granularity === "week" ? weekKey : monthKey;

  // Records for the table (window + all filters incl. bucket click).
  const q = search.toLowerCase();
  const passesFilters = (r: AchievementRow): boolean => {
    if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
    if (type && r.trainingType !== type) return false;
    if (theatre && r.theatre !== theatre) return false;
    if (region && r.region !== region) return false;
    if (country && r.country !== country) return false;
    if (fn && r.function !== fn) return false;
    if (product && r.productType !== product) return false;
    return true;
  };

  const filtered = records.filter((r) => {
    const completed = new Date(r.completedDate);
    if (completed < windowStart || completed > windowEnd) return false;
    if (!passesFilters(r)) return false;
    if (bucket && bucketKey(completed) !== bucket) return false;
    return true;
  });

  // Records for the chart — same filters as the table EXCEPT window + bucket.
  const chartRecords = records.filter(passesFilters);

  // Bucket axis for the chart (starts at axisStart, not 1970 under "All time").
  const buckets: { key: string; label: string }[] = [];
  if (granularity === "month") {
    let d = new Date(axisStart.getFullYear(), axisStart.getMonth(), 1);
    while (d <= windowEnd) {
      buckets.push({ key: monthKey(d), label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }) });
      d = addMonths(d, 1);
    }
  } else if (granularity === "week") {
    let d = weekStart(axisStart);
    while (d <= windowEnd) {
      buckets.push({ key: weekKey(d), label: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) });
      d = addDays(d, 7);
    }
  } else {
    let d = startOfDay(axisStart);
    while (d <= windowEnd) {
      buckets.push({ key: dayKey(d), label: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) });
      d = addDays(d, 1);
    }
  }

  const counts = new Map<string, number>();
  const priorCounts = new Map<string, number>();
  const shiftMs = windowStart.getTime() - priorStart.getTime();
  for (const r of chartRecords) {
    const completed = new Date(r.completedDate);
    if (completed >= windowStart && completed <= windowEnd) {
      const k = bucketKey(completed);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    } else if (completed >= priorStart && completed <= priorEnd) {
      const aligned = new Date(completed.getTime() + shiftMs);
      const ak = bucketKey(aligned);
      priorCounts.set(ak, (priorCounts.get(ak) ?? 0) + 1);
    }
  }
  const chartData = buckets.map((b) => ({
    bucketKey: b.key,
    label: b.label,
    "This period": counts.get(b.key) ?? 0,
    "Prior period": priorCounts.get(b.key) ?? 0,
  }));

  // Top 10 trainings (from the filtered table set).
  const titleCounts = new Map<string, number>();
  const productByTitle = new Map<string, string>();
  for (const r of filtered) {
    titleCounts.set(r.trainingTitle, (titleCounts.get(r.trainingTitle) ?? 0) + 1);
    if (r.productType && !productByTitle.has(r.trainingTitle)) productByTitle.set(r.trainingTitle, r.productType);
  }
  const topTitles = Array.from(titleCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([title, count]) => ({ title, count, productType: productByTitle.get(title) ?? "" }));

  // KPIs.
  const thisPeriodTotal = chartData.reduce((s, m) => s + m["This period"], 0);
  const priorPeriodTotal = chartData.reduce((s, m) => s + m["Prior period"], 0);
  const change = priorPeriodTotal === 0 ? 0 : ((thisPeriodTotal - priorPeriodTotal) / priorPeriodTotal) * 100;
  const kpis = {
    total: filtered.length,
    cert: filtered.filter((r) => r.trainingType === "Certification").length,
    accred: filtered.filter((r) => r.trainingType === "Accreditation").length,
    ilt: filtered.filter((r) => r.trainingType === "Instructor-Led Training").length,
    olx: filtered.filter((r) => r.trainingType === "OLX").length,
    thisPeriodTotal,
    priorPeriodTotal,
    change,
  };

  // Sort (empties last, numeric-aware; stable tiebreak on fullName).
  const active = SORT_ACCESSORS[sortColumn] ?? SORT_ACCESSORS.fullName;
  const tiebreak = SORT_ACCESSORS.fullName;
  const sorted = [...filtered].sort((a, b) => {
    const primary = compare(active(a), active(b));
    const signed = sortDir === "asc" ? primary : -primary;
    if (signed !== 0) return signed;
    if (sortColumn !== "fullName") return compare(tiebreak(a), tiebreak(b));
    return 0;
  });

  // Grouping.
  let ordered: AchievementRow[];
  let groups: { key: string; total: number }[];
  if (groupBy) {
    const grouped = groupRows(sorted, groupBy);
    groups = grouped.map((g) => ({ key: g.key, total: g.rows.length }));
    ordered = grouped.flatMap((g) => g.rows);
  } else {
    groups = [];
    ordered = sorted;
  }

  const total = ordered.length;
  const rows = all ? ordered : ordered.slice((page - 1) * pageSize, page * pageSize);

  return { charts: { chartData, topTitles, granularity }, kpis, groups, rows, total, page, pageSize, filterOptions };
}
