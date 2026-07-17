/**
 * Server-side aggregation + pagination for the Legacy Replacement Gap report
 * (`/api/reports/legacy-gap`, rendered at `/reports/legacy-gap`).
 *
 * The report used to ship every annotated gap row to the browser and
 * filter/aggregate/render it client-side (charts + KPIs + every row via
 * GroupedRows, no pagination). This module wraps the existing
 * `computeLegacyGaps` query with the page's exact filter/sort/group/pagination
 * so the browser downloads only a small summary plus one page of rows.
 *
 * The pure helpers (HORIZONS / bucketHorizon) are exported so the page imports
 * the very same definitions and the two sides can't drift.
 */

import { groupRows, type GroupByMode } from "@/lib/group-by";
import { computeLegacyGaps, type LegacyGapRecord } from "@/lib/legacy-gap";

// ─── Shared pure helpers (also imported by the page) ────────────────────────────

export const HORIZONS: { key: string; label: string }[] = [
  { key: "expired", label: "Expired" },
  { key: "0-1", label: "≤ 1 month" },
  { key: "1-3", label: "1–3 months" },
  { key: "3-6", label: "3–6 months" },
  { key: "6-12", label: "6–12 months" },
  { key: "12+", label: "12+ months" },
];

function monthsBetween(now: Date, future: Date): number {
  return (future.getFullYear() - now.getFullYear()) * 12 + (future.getMonth() - now.getMonth());
}

export function bucketHorizon(expiry: Date, now: Date): string {
  if (expiry <= now) return "expired";
  const m = monthsBetween(now, expiry);
  if (m <= 1) return "0-1";
  if (m <= 3) return "1-3";
  if (m <= 6) return "3-6";
  if (m <= 12) return "6-12";
  return "12+";
}

// ─── Types ──────────────────────────────────────────────────────────────────────

export type LegacyGapRow = LegacyGapRecord;

export interface LegacyGapInput {
  companyIds: number[] | null;
  search?: string;
  window?: string;
  type?: string;
  product?: string;
  theatre?: string;
  region?: string;
  country?: string;
  horizon?: string | null;
  includeNoReplacement?: boolean;
  requireActive?: boolean;
  groupBy?: GroupByMode | null;
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  all?: boolean;
}

export interface LegacyGapResult {
  charts: {
    horizonSeries: { name: string; Certification: number; Accreditation: number; horizonKey: string }[];
    productSeries: { name: string; gaps: number }[];
  };
  kpis: { total: number; expired: number; soon: number; noReplacement: number };
  groups: { key: string; total: number }[];
  rows: LegacyGapRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: { products: string[] };
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

const SORT_ACCESSORS: Record<string, (r: LegacyGapRow) => SortValue> = {
  fullName: (r) => r.fullName,
  email: (r) => r.email,
  theatre: (r) => r.theatre,
  region: (r) => r.region,
  country: (r) => r.country,
  legacyFullTitle: (r) => r.legacyFullTitle,
  legacyType: (r) => r.legacyType,
  productType: (r) => r.productType,
  replacementFullTitle: (r) => (r.replacementDefined ? r.replacementFullTitle : ""),
  legacyCompletedDate: (r) => r.legacyCompletedDate,
  legacyExpiryDate: (r) => r.legacyExpiryDate,
  legacyActive: (r) => r.legacyActive,
};

// ─── Main compute ────────────────────────────────────────────────────────────────

export async function computeLegacyGapReport(input: LegacyGapInput): Promise<LegacyGapResult> {
  const records = await computeLegacyGaps(input.companyIds);
  return computeFromRecords(records, input);
}

export function computeFromRecords(
  records: LegacyGapRow[],
  input: Omit<LegacyGapInput, "companyIds">,
  now: Date = new Date(),
): LegacyGapResult {
  const {
    search = "",
    window = "all",
    type = "",
    product = "",
    theatre = "",
    region = "",
    country = "",
    horizon = null,
    includeNoReplacement = true,
    requireActive = true,
    groupBy = null,
    sortColumn = "fullName",
    sortDir = "asc",
    all = false,
  } = input;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, input.pageSize ?? 25);

  const filterOptions = {
    products: [...new Set(records.map((r) => r.productType))].filter(Boolean).sort(),
  };

  // The exact `filtered` predicate from the page.
  const q = search.toLowerCase();
  const filtered = records.filter((r) => {
    if (!includeNoReplacement && !r.replacementDefined) return false;
    if (!requireActive && r.replacementState === "expired-only") return false;
    if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q) && !r.legacyFullTitle.toLowerCase().includes(q)) return false;
    if (type && r.legacyType !== type) return false;
    if (product && r.productType !== product) return false;
    if (theatre && r.theatre !== theatre) return false;
    if (region && r.region !== region) return false;
    if (country && r.country !== country) return false;

    const expiry = new Date(r.legacyExpiryDate);
    if (window === "expired") {
      if (expiry > now) return false;
    } else if (window !== "all") {
      const months = parseInt(window);
      const cutoff = new Date(now);
      cutoff.setMonth(cutoff.getMonth() + months);
      if (expiry <= now || expiry > cutoff) return false;
    }
    if (horizon && bucketHorizon(expiry, now) !== horizon) return false;
    return true;
  });

  // Charts.
  const horizonCounts: Record<string, { name: string; Certification: number; Accreditation: number; horizonKey: string }> = {};
  for (const h of HORIZONS) horizonCounts[h.key] = { name: h.label, Certification: 0, Accreditation: 0, horizonKey: h.key };
  for (const r of filtered) {
    const b = bucketHorizon(new Date(r.legacyExpiryDate), now);
    if (r.legacyType === "Accreditation") horizonCounts[b].Accreditation++;
    else horizonCounts[b].Certification++;
  }
  const horizonSeries = HORIZONS.map((h) => horizonCounts[h.key]);

  const productMap = new Map<string, number>();
  for (const r of filtered) productMap.set(r.productType, (productMap.get(r.productType) ?? 0) + 1);
  const productSeries = [...productMap.entries()].map(([name, value]) => ({ name, gaps: value })).sort((a, b) => b.gaps - a.gaps).slice(0, 12);

  const kpis = {
    total: filtered.length,
    expired: filtered.filter((r) => !r.legacyActive).length,
    soon: filtered.filter((r) => { const b = bucketHorizon(new Date(r.legacyExpiryDate), now); return b === "0-1" || b === "1-3"; }).length,
    noReplacement: filtered.filter((r) => !r.replacementDefined).length,
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
  let ordered: LegacyGapRow[];
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

  return { charts: { horizonSeries, productSeries }, kpis, groups, rows, total, page, pageSize, filterOptions };
}
