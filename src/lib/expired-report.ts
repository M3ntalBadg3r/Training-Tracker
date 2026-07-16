/**
 * Server-side computation for the Currently Expired report
 * (`/api/reports/expired`, rendered at `/reports/expired`).
 *
 * The report used to ship the entire `/api/reports/training-records` dataset to
 * the browser and filter/aggregate/render it client-side (charts + KPIs + every
 * row via GroupedRows, no pagination). This module moves that work to the server
 * so the browser downloads only a small summary plus one page of rows.
 *
 * Parity: the aggregation here is a faithful move of the old client code. It
 * builds the same deduped record rows as the training-records route (ISO date
 * strings), then runs the identical `filtered` predicate, `bucketLapse` bucket
 * math, chart rollups, KPI counts, sort and grouping — so every number matches
 * byte-for-byte. Only the detail table is paginated (the accepted UX change).
 *
 * The pure helpers (TYPES / BUCKETS / monthsBetween / bucketLapse) are exported
 * so the page imports the very same definitions and the two sides can't drift.
 */

import { resolveBucket, groupRows, type GroupByMode } from "@/lib/group-by";
import { fetchDedupedTrainingRecords, type DedupedTrainingRecord } from "@/lib/training-records-query";

// ─── Shared pure helpers (also imported by the page) ────────────────────────────

export const TYPES = ["Certification", "Accreditation", "Instructor-Led Training", "OLX"] as const;
export type ExpiredType = (typeof TYPES)[number];

/** How long ago a record lapsed. The oldest band lumps everything > 12 months. */
export const BUCKETS: { key: string; label: string }[] = [
  { key: "0-1", label: "≤ 1 month" },
  { key: "1-3", label: "1–3 months" },
  { key: "3-6", label: "3–6 months" },
  { key: "6-12", label: "6–12 months" },
  { key: "12+", label: "> 12 months" },
];

export function monthsBetween(earlier: Date, later: Date): number {
  return (later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
}

export function bucketLapse(expiry: Date, now: Date): string | null {
  if (expiry >= now) return null;
  const m = monthsBetween(expiry, now);
  if (m <= 1) return "0-1";
  if (m <= 3) return "1-3";
  if (m <= 6) return "3-6";
  if (m <= 12) return "6-12";
  return "12+";
}

// ─── Types ──────────────────────────────────────────────────────────────────────

/** One detail row — the shared deduped training-record shape. */
export type ExpiredRow = DedupedTrainingRecord;

type TypeCounts = { name: string; Certification: number; Accreditation: number; "Instructor-Led Training": number; OLX: number };

export interface ExpiredReportInput {
  companyIds: number[] | null;
  search?: string;
  type?: string;
  theatre?: string;
  bucket?: string | null;
  excludeRetired?: boolean;
  groupBy?: GroupByMode | null;
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  /** When true, return the full filtered+ordered set (for export) and skip paging. */
  all?: boolean;
}

export interface ExpiredReportResult {
  charts: { bucketSeries: (TypeCounts & { bucketKey: string })[]; theatreSeries: TypeCounts[] };
  kpis: { total: number; m1: number; m3: number; longOverdue: number };
  groups: { key: string; total: number }[];
  rows: ExpiredRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: { types: string[]; theatres: string[] };
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

const SORT_ACCESSORS: Record<string, (r: ExpiredRow) => SortValue> = {
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
};

// ─── Main compute ────────────────────────────────────────────────────────────────

function emptyTypeCounts(name: string): TypeCounts {
  return { name, Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 };
}

export async function computeExpiredReport(input: ExpiredReportInput): Promise<ExpiredReportResult> {
  const records = await fetchDedupedTrainingRecords(input.companyIds);
  return computeFromRecords(records, input);
}

/**
 * Pure aggregation over an already-fetched deduped record set. Split out from the
 * DB fetch so it can be parity-tested directly against the old client logic.
 * `now` is injectable for deterministic tests (defaults to the current time).
 */
export function computeFromRecords(
  records: ExpiredRow[],
  input: Omit<ExpiredReportInput, "companyIds">,
  now: Date = new Date(),
): ExpiredReportResult {
  const {
    search = "",
    type = "",
    theatre = "",
    bucket = null,
    excludeRetired = false,
    groupBy = null,
    sortColumn = "fullName",
    sortDir = "asc",
    all = false,
  } = input;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, input.pageSize ?? 25);

  // Dropdown options come from the full in-scope record set (matches the page).
  const filterOptions = {
    types: [...new Set(records.map((r) => r.trainingType))].filter(Boolean).sort(),
    theatres: [...new Set(records.map((r) => r.theatre))].filter(Boolean).sort(),
  };

  // The exact `filtered` predicate from the page.
  const q = search.toLowerCase();
  const filtered = records.filter((r) => {
    const expiry = new Date(r.expiryDate);
    if (expiry >= now) return false;
    if (excludeRetired && r.isLegacy) return false;
    if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
    if (type && r.trainingType !== type) return false;
    if (theatre && r.theatre !== theatre) return false;
    if (bucket) {
      const b = bucketLapse(expiry, now);
      if (b !== bucket) return false;
    }
    return true;
  });

  // Charts.
  const bucketCounts: Record<string, TypeCounts> = {};
  for (const b of BUCKETS) bucketCounts[b.key] = emptyTypeCounts(b.label);
  for (const r of filtered) {
    const b = bucketLapse(new Date(r.expiryDate), now);
    if (!b) continue;
    const key = r.trainingType as ExpiredType;
    if ((TYPES as readonly string[]).includes(key)) bucketCounts[b][key]++;
  }
  const bucketSeries = BUCKETS.map((b) => ({ ...bucketCounts[b.key], bucketKey: b.key }));

  const byTheatre = new Map<string, TypeCounts>();
  for (const r of filtered) {
    const t = r.theatre || "Unknown";
    if (!byTheatre.has(t)) byTheatre.set(t, emptyTypeCounts(t));
    const key = r.trainingType as ExpiredType;
    if ((TYPES as readonly string[]).includes(key)) byTheatre.get(t)![key]++;
  }
  const theatreSeries = [...byTheatre.values()].sort((a, b) => a.name.localeCompare(b.name));

  // KPIs.
  const kpis = {
    total: filtered.length,
    m1: filtered.filter((r) => bucketLapse(new Date(r.expiryDate), now) === "0-1").length,
    m3: filtered.filter((r) => {
      const b = bucketLapse(new Date(r.expiryDate), now);
      return b === "0-1" || b === "1-3";
    }).length,
    longOverdue: filtered.filter((r) => bucketLapse(new Date(r.expiryDate), now) === "12+").length,
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

  // Grouping: replicate groupRows(sorted, groupBy) — groups sorted by key asc,
  // rows within a group kept in `sorted` order — then flatten for pagination.
  let ordered: ExpiredRow[];
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

  return { charts: { bucketSeries, theatreSeries }, kpis, groups, rows, total, page, pageSize, filterOptions };
}

/** The group each detail row belongs to (so the client can render headers). */
export function rowGroupKey(row: ExpiredRow, groupBy: GroupByMode): string {
  return resolveBucket(row, groupBy);
}
