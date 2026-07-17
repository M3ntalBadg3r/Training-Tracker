/**
 * Server-side computation for the Expiring Soon report
 * (`/api/reports/expiring-soon`, rendered at `/reports/expiring-soon`).
 *
 * The report used to ship the entire `/api/reports/training-records` dataset to
 * the browser and filter/aggregate/render it client-side (charts + KPIs + every
 * row via GroupedRows, no pagination). This module moves that work to the server
 * so the browser downloads only a small summary plus one page of rows.
 *
 * Parity: the aggregation here is a faithful move of the old client code. It
 * builds the same deduped record rows as the training-records route (ISO date
 * strings), then runs the identical `filtered` predicate, `bucketHorizon` math,
 * chart rollups, KPI counts, sort and grouping — so every number matches. Only
 * the detail table is paginated (the accepted UX change).
 *
 * The pure helpers (HORIZONS / bucketHorizon) are exported so the page imports the
 * very same definitions and the two sides can't drift.
 */

import { groupRows, type GroupByMode } from "@/lib/group-by";
import { fetchDedupedTrainingRecords, type DedupedTrainingRecord } from "@/lib/training-records-query";

// ─── Shared pure helpers (also imported by the page) ────────────────────────────

const TYPES = ["Certification", "Accreditation", "Instructor-Led Training", "OLX"] as const;
type ExpiringType = (typeof TYPES)[number];

export const HORIZONS: { key: string; label: string; months: number }[] = [
  { key: "0-1", label: "≤ 1 month", months: 1 },
  { key: "1-3", label: "1–3 months", months: 3 },
  { key: "3-6", label: "3–6 months", months: 6 },
  { key: "6-12", label: "6–12 months", months: 12 },
];

function monthsBetween(now: Date, future: Date): number {
  return (future.getFullYear() - now.getFullYear()) * 12 + (future.getMonth() - now.getMonth());
}

export function bucketHorizon(expiry: Date, now: Date): string | null {
  if (expiry <= now) return null;
  const m = monthsBetween(now, expiry);
  if (m <= 1) return "0-1";
  if (m <= 3) return "1-3";
  if (m <= 6) return "3-6";
  if (m <= 12) return "6-12";
  return null;
}

// ─── Types ──────────────────────────────────────────────────────────────────────

export type ExpiringRow = DedupedTrainingRecord;

type TypeCounts = { name: string; Certification: number; Accreditation: number; "Instructor-Led Training": number; OLX: number };

export interface ExpiringSoonInput {
  companyIds: number[] | null;
  search?: string;
  window?: string;
  type?: string;
  theatre?: string;
  region?: string;
  country?: string;
  horizon?: string | null;
  groupBy?: GroupByMode | null;
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  /** When true, return the full filtered+ordered set (for export) and skip paging. */
  all?: boolean;
}

export interface ExpiringSoonResult {
  charts: {
    horizonSeries: (TypeCounts & { horizonKey: string })[];
    heatmap: { theatres: string[]; data: Record<string, string | number>[] };
  };
  kpis: { total: number; m1: number; m3: number; m6: number };
  groups: { key: string; total: number }[];
  rows: ExpiringRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: { types: string[] };
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

const SORT_ACCESSORS: Record<string, (r: ExpiringRow) => SortValue> = {
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

function emptyTypeCounts(name: string): TypeCounts {
  return { name, Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 };
}

export async function computeExpiringSoon(input: ExpiringSoonInput): Promise<ExpiringSoonResult> {
  const records = await fetchDedupedTrainingRecords(input.companyIds);
  return computeFromRecords(records, input);
}

/**
 * Pure aggregation over an already-fetched deduped record set. `now` is injectable
 * for deterministic tests (defaults to the current time).
 */
export function computeFromRecords(
  records: ExpiringRow[],
  input: Omit<ExpiringSoonInput, "companyIds">,
  now: Date = new Date(),
): ExpiringSoonResult {
  const {
    search = "",
    window = "12",
    type = "",
    theatre = "",
    region = "",
    country = "",
    horizon = null,
    groupBy = null,
    sortColumn = "fullName",
    sortDir = "asc",
    all = false,
  } = input;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, input.pageSize ?? 25);

  const filterOptions = {
    types: [...new Set(records.map((r) => r.trainingType))].filter(Boolean).sort(),
  };

  // The exact `filtered` predicate from the page.
  const q = search.toLowerCase();
  const months = parseInt(window) || 12;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() + months);
  const filtered = records.filter((r) => {
    const expiry = new Date(r.expiryDate);
    if (expiry <= now || expiry > cutoff) return false;
    if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
    if (type && r.trainingType !== type) return false;
    if (theatre && r.theatre !== theatre) return false;
    if (region && r.region !== region) return false;
    if (country && r.country !== country) return false;
    if (horizon) {
      const b = bucketHorizon(expiry, now);
      if (b !== horizon) return false;
    }
    return true;
  });

  // Horizon stacked-bar series.
  const horizonCounts: Record<string, TypeCounts> = {};
  for (const h of HORIZONS) horizonCounts[h.key] = emptyTypeCounts(h.label);
  for (const r of filtered) {
    const b = bucketHorizon(new Date(r.expiryDate), now);
    if (!b) continue;
    const key = r.trainingType as ExpiringType;
    if ((TYPES as readonly string[]).includes(key)) horizonCounts[b][key]++;
  }
  const horizonSeries = HORIZONS.map((h) => ({ ...horizonCounts[h.key], horizonKey: h.key }));

  // Theatre × month heatmap (as a stacked bar): months on X, one series per theatre.
  const heatmapMonths: { key: string; label: string }[] = [];
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 0; i < 12; i++) {
    const d = new Date(start);
    d.setMonth(start.getMonth() + i);
    heatmapMonths.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
    });
  }
  const heatmapTheatres = [...new Set(filtered.map((r) => r.theatre))].filter(Boolean).sort();
  const heatmapData = heatmapMonths.map((m) => ({ month: m.label } as Record<string, string | number>));
  for (const t of heatmapTheatres) heatmapData.forEach((r) => (r[t] = 0));
  for (const r of filtered) {
    const expiry = new Date(r.expiryDate);
    const key = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, "0")}`;
    const idx = heatmapMonths.findIndex((m) => m.key === key);
    if (idx === -1) continue;
    const target = heatmapData[idx];
    target[r.theatre] = ((target[r.theatre] as number) || 0) + 1;
  }

  // KPIs.
  const kpis = {
    total: filtered.length,
    m1: filtered.filter((r) => bucketHorizon(new Date(r.expiryDate), now) === "0-1").length,
    m3: filtered.filter((r) => {
      const b = bucketHorizon(new Date(r.expiryDate), now);
      return b === "0-1" || b === "1-3";
    }).length,
    m6: filtered.filter((r) => {
      const b = bucketHorizon(new Date(r.expiryDate), now);
      return b === "0-1" || b === "1-3" || b === "3-6";
    }).length,
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

  // Grouping: replicate groupRows(sorted, groupBy) then flatten for pagination.
  let ordered: ExpiringRow[];
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

  return {
    charts: { horizonSeries, heatmap: { theatres: heatmapTheatres, data: heatmapData } },
    kpis,
    groups,
    rows,
    total,
    page,
    pageSize,
    filterOptions,
  };
}
