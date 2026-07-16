/**
 * Server-side computation for the Theatre / Region / Country Comparison report
 * (`/api/reports/comparison`, rendered at `/reports/comparison`).
 *
 * The report used to download the full training-records + students datasets and
 * build the per-geography comparison matrix + charts in the browser. This module
 * moves that to the server (cached) and returns only the small aggregated result
 * (one row per geography bucket — no pagination needed). Sorting stays on the
 * client since the matrix is tiny.
 *
 * Parity: `computeFromInputs` is a faithful move of the page's memos
 * (`filteredRecords` → `metrics`/`totals`, `windowedRecords` → the breakdown/time
 * charts). All controls are parameters, so every number matches the page.
 */

import prisma from "@/lib/prisma";
import { resolveBucket, type GroupByMode } from "@/lib/group-by";
import { fetchDedupedTrainingRecords, type DedupedTrainingRecord } from "@/lib/training-records-query";

// ─── Types ──────────────────────────────────────────────────────────────────────

export type CompareMode = "type" | "function" | "product" | "time";
export type RangePreset = "12m" | "6m" | "3m" | "all" | "custom";

export interface ComparisonStudent {
  theatre: string | null;
  country: string | null;
  region: string | null;
}

export interface BucketMetrics {
  bucket: string;
  headcount: number;
  cert: number;
  accred: number;
  ilt: number;
  olx: number;
  total: number;
  perStudent: number;
  exp3: number;
  exp6: number;
}

export interface ComparisonInput {
  companyIds: number[] | null;
  geoMode?: GroupByMode;
  rangePreset?: RangePreset;
  customFrom?: string | null; // yyyy-mm-dd
  customTo?: string | null;   // yyyy-mm-dd
  filterFunction?: string;
  filterProduct?: string;
  filterType?: string;
  compareMode?: CompareMode;
}

export interface ComparisonChart {
  mode: CompareMode;
  rows: Record<string, string | number>[];
  series: string[];
}

export interface ComparisonResult {
  metrics: BucketMetrics[];
  totals: { headcount: number; cert: number; accred: number; ilt: number; olx: number; total: number; exp3: number; exp6: number };
  chart: ComparisonChart;
  filterOptions: { functions: string[]; products: string[]; types: string[] };
}

const TYPE_ORDER = ["Certification", "Accreditation", "Instructor-Led Training", "OLX"] as const;

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d: Date): Date { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
function addMonths(d: Date, n: number): Date { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }

const RANGE_MONTHS: Record<string, number> = { "12m": 12, "6m": 6, "3m": 3 };

// ─── Fetch + compute ─────────────────────────────────────────────────────────────

export async function computeComparison(input: ComparisonInput): Promise<ComparisonResult> {
  const [studentRows, records] = await Promise.all([
    prisma.student.findMany({
      where: input.companyIds ? { companyId: { in: input.companyIds } } : {},
      select: { theatre: true, country: true, regionData: { select: { region: true } } },
    }),
    fetchDedupedTrainingRecords(input.companyIds),
  ]);
  const students: ComparisonStudent[] = studentRows.map((s) => ({
    theatre: s.theatre,
    country: s.country,
    region: s.regionData?.region ?? null,
  }));
  return computeFromInputs(students, records, input);
}

/**
 * Pure aggregation over already-fetched students + records. Split from the fetch
 * so it can be parity-tested directly against the page's client memos. `now` is
 * injectable for deterministic tests.
 */
export function computeFromInputs(
  students: ComparisonStudent[],
  records: DedupedTrainingRecord[],
  input: Omit<ComparisonInput, "companyIds">,
  now: Date = new Date(),
): ComparisonResult {
  const {
    geoMode = "theatre",
    rangePreset = "12m",
    customFrom = null,
    customTo = null,
    filterFunction = "",
    filterProduct = "",
    filterType = "",
    compareMode = "type",
  } = input;

  // Filter option lists come from all records (unfiltered), matching the page.
  const filterOptions = {
    functions: [...new Set(records.map((r) => r.function))].filter(Boolean).sort(),
    products: [...new Set(records.map((r) => r.productType))].filter(Boolean).sort(),
    types: [...new Set(records.map((r) => r.trainingType))].filter(Boolean).sort(),
  };

  // Completion time-range bounds.
  let windowStart: Date | null;
  let windowEnd: Date;
  if (rangePreset === "custom") {
    windowStart = customFrom ? startOfDay(new Date(customFrom)) : null;
    windowEnd = customTo ? endOfDay(new Date(customTo)) : now;
  } else if (rangePreset === "all") {
    windowStart = null;
    windowEnd = now;
  } else {
    const months = RANGE_MONTHS[rangePreset] ?? 12;
    const d = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    d.setHours(0, 0, 0, 0);
    windowStart = d;
    windowEnd = now;
  }

  const filteredRecords = records.filter((r) => {
    if (filterFunction && r.function !== filterFunction) return false;
    if (filterProduct && r.productType !== filterProduct) return false;
    if (filterType && r.trainingType !== filterType) return false;
    return true;
  });

  // Headcount per bucket — distinct students at the chosen geo level.
  const headcountByBucket = new Map<string, number>();
  for (const s of students) {
    const b = resolveBucket(s, geoMode);
    headcountByBucket.set(b, (headcountByBucket.get(b) ?? 0) + 1);
  }

  const exp3Cutoff = addMonths(now, 3);
  const exp6Cutoff = addMonths(now, 6);

  const map = new Map<string, BucketMetrics>();
  const ensure = (bucket: string): BucketMetrics => {
    let row = map.get(bucket);
    if (!row) {
      row = { bucket, headcount: 0, cert: 0, accred: 0, ilt: 0, olx: 0, total: 0, perStudent: 0, exp3: 0, exp6: 0 };
      map.set(bucket, row);
    }
    return row;
  };
  for (const [bucket, count] of headcountByBucket) ensure(bucket).headcount = count;

  for (const r of filteredRecords) {
    const bucket = resolveBucket(r, geoMode);
    const row = ensure(bucket);
    const completed = new Date(r.completedDate);
    const inWindow = (!windowStart || completed >= windowStart) && completed <= windowEnd;
    if (inWindow) {
      row.total += 1;
      if (r.trainingType === "Certification") row.cert += 1;
      else if (r.trainingType === "Accreditation") row.accred += 1;
      else if (r.trainingType === "Instructor-Led Training") row.ilt += 1;
      else if (r.trainingType === "OLX") row.olx += 1;
    }
    if (r.active && r.expiryDate) {
      const exp = new Date(r.expiryDate);
      if (exp >= now && exp <= exp6Cutoff) {
        row.exp6 += 1;
        if (exp <= exp3Cutoff) row.exp3 += 1;
      }
    }
  }
  for (const row of map.values()) {
    row.perStudent = row.headcount > 0 ? row.total / row.headcount : 0;
  }
  const metrics = Array.from(map.values());

  const totals = metrics.reduce(
    (acc, r) => {
      acc.headcount += r.headcount; acc.cert += r.cert; acc.accred += r.accred; acc.ilt += r.ilt;
      acc.olx += r.olx; acc.total += r.total; acc.exp3 += r.exp3; acc.exp6 += r.exp6;
      return acc;
    },
    { headcount: 0, cert: 0, accred: 0, ilt: 0, olx: 0, total: 0, exp3: 0, exp6: 0 },
  );

  // Records within the completion window (for the chart breakdowns).
  const windowedRecords = filteredRecords.filter((r) => {
    const d = new Date(r.completedDate);
    if (windowStart && d < windowStart) return false;
    return d <= windowEnd;
  });

  const topBuckets = [...metrics].sort((a, b) => b.total - a.total).slice(0, 8).map((m) => m.bucket);

  let chart: ComparisonChart;
  if (compareMode === "time") {
    const start = windowStart ?? (() => {
      let min: number | null = null;
      for (const r of windowedRecords) {
        const t = new Date(r.completedDate).getTime();
        if (Number.isFinite(t) && (min === null || t < min)) min = t;
      }
      return min === null ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(min);
    })();
    const months: { key: string; label: string }[] = [];
    let d = new Date(start.getFullYear(), start.getMonth(), 1);
    const end = new Date(windowEnd.getFullYear(), windowEnd.getMonth(), 1);
    while (d <= end) {
      months.push({ key: monthKey(d), label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }) });
      d = addMonths(d, 1);
    }
    const series = topBuckets;
    const counts = new Map<string, Record<string, number>>();
    for (const r of windowedRecords) {
      const bucket = resolveBucket(r, geoMode);
      if (!series.includes(bucket)) continue;
      const k = monthKey(new Date(r.completedDate));
      let entry = counts.get(k);
      if (!entry) { entry = {}; counts.set(k, entry); }
      entry[bucket] = (entry[bucket] ?? 0) + 1;
    }
    const rows = months.map((m) => ({
      label: m.label,
      ...series.reduce((o, s) => ({ ...o, [s]: counts.get(m.key)?.[s] ?? 0 }), {}),
    }));
    chart = { mode: "time", rows, series };
  } else {
    const seriesSet = new Set<string>();
    const byBucket = new Map<string, Record<string, number>>();
    for (const r of windowedRecords) {
      const bucket = resolveBucket(r, geoMode);
      const cat = compareMode === "type" ? r.trainingType : compareMode === "function" ? r.function : r.productType;
      if (!cat) continue;
      seriesSet.add(cat);
      let entry = byBucket.get(bucket);
      if (!entry) { entry = {}; byBucket.set(bucket, entry); }
      entry[cat] = (entry[cat] ?? 0) + 1;
    }
    const series = compareMode === "type"
      ? TYPE_ORDER.filter((t) => seriesSet.has(t))
      : [...seriesSet].sort();
    const rows = [...byBucket.entries()]
      .map(([bucket, counts]) => ({ bucket, ...series.reduce((o, s) => ({ ...o, [s]: counts[s] ?? 0 }), {}) }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));
    chart = { mode: compareMode, rows, series: series as string[] };
  }

  return { metrics, totals, chart, filterOptions };
}
