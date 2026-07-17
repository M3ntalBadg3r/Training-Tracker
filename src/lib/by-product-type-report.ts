/**
 * Server-side computation for the By Product Type report
 * (`/api/reports/by-product-type`, rendered at `/reports/by-product-type`).
 *
 * The report used to ship the entire `/api/reports/training-records` dataset to
 * the browser and filter/aggregate/render it client-side (charts + KPIs + every
 * row via GroupedRows, no pagination). This module moves that work to the server
 * so the browser downloads only a small summary plus one page of rows.
 *
 * Parity: same deduped record rows as the training-records route (ISO date
 * strings), same `filtered` predicate (search / product / type / geo / completed
 * date range), same KPI + stacked-bar rollups (record-based, or distinct
 * active-holder emails when `countPeople` is on), sort and grouping. Only the
 * detail table is paginated.
 */

import { groupRows, type GroupByMode } from "@/lib/group-by";
import { fetchDedupedTrainingRecords, type DedupedTrainingRecord } from "@/lib/training-records-query";

const TYPES = ["Certification", "Accreditation", "Instructor-Led Training", "OLX"] as const;
type ReportType = (typeof TYPES)[number];

// ─── Types ──────────────────────────────────────────────────────────────────────

export type ByProductTypeRow = DedupedTrainingRecord;

type ProductCell = { name: string; Certification: number; Accreditation: number; "Instructor-Led Training": number; OLX: number };

export interface ByProductTypeInput {
  companyIds: number[] | null;
  search?: string;
  product?: string;
  type?: string;
  theatre?: string;
  region?: string;
  country?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  countPeople?: boolean;
  groupBy?: GroupByMode | null;
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  all?: boolean;
}

export interface ByProductTypeResult {
  charts: { productSeries: ProductCell[] };
  kpis: { total: number; cert: number; accred: number; ilt: number; olx: number; active: number; expired: number };
  groups: { key: string; total: number; active: number }[];
  rows: ByProductTypeRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: { products: string[]; types: string[] };
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

const SORT_ACCESSORS: Record<string, (r: ByProductTypeRow) => SortValue> = {
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

export async function computeByProductType(input: ByProductTypeInput): Promise<ByProductTypeResult> {
  const records = await fetchDedupedTrainingRecords(input.companyIds);
  return computeFromRecords(records, input);
}

export function computeFromRecords(
  records: ByProductTypeRow[],
  input: Omit<ByProductTypeInput, "companyIds">,
): ByProductTypeResult {
  const {
    search = "",
    product = "",
    type = "",
    theatre = "",
    region = "",
    country = "",
    dateFrom = null,
    dateTo = null,
    countPeople = false,
    groupBy = null,
    sortColumn = "fullName",
    sortDir = "asc",
    all = false,
  } = input;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, input.pageSize ?? 25);

  const filterOptions = {
    products: [...new Set(records.map((r) => r.productType))].filter(Boolean).sort(),
    types: [...new Set(records.map((r) => r.trainingType))].filter(Boolean).sort(),
  };

  // Completed-date range (mirrors DateRangePicker's filterByRange).
  const from = dateFrom ? new Date(dateFrom) : null;
  const to = dateTo ? new Date(dateTo) : null;
  const toEnd = to ? new Date(to) : null;
  if (toEnd) toEnd.setHours(23, 59, 59, 999);

  const q = search.toLowerCase();
  const filtered = records.filter((r) => {
    if (from || toEnd) {
      const d = new Date(r.completedDate);
      if (from && d < from) return false;
      if (toEnd && d > toEnd) return false;
    }
    if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
    if (product && r.productType !== product) return false;
    if (type && r.trainingType !== type) return false;
    if (theatre && r.theatre !== theatre) return false;
    if (region && r.region !== region) return false;
    if (country && r.country !== country) return false;
    return true;
  });

  // KPIs. active/expired stay record-based (they power the status donut); the
  // per-type figures count distinct active holders when `countPeople` is on.
  const activeCount = filtered.filter((r) => r.active).length;
  let kpis: ByProductTypeResult["kpis"];
  if (countPeople) {
    const people = (t?: string) => {
      const s = new Set<string>();
      for (const r of filtered) {
        if (!r.active) continue;
        if (t && r.trainingType !== t) continue;
        s.add(r.email);
      }
      return s.size;
    };
    kpis = {
      total: people(),
      cert: people("Certification"),
      accred: people("Accreditation"),
      ilt: people("Instructor-Led Training"),
      olx: people("OLX"),
      active: activeCount,
      expired: filtered.length - activeCount,
    };
  } else {
    kpis = {
      total: filtered.length,
      cert: filtered.filter((r) => r.trainingType === "Certification").length,
      accred: filtered.filter((r) => r.trainingType === "Accreditation").length,
      ilt: filtered.filter((r) => r.trainingType === "Instructor-Led Training").length,
      olx: filtered.filter((r) => r.trainingType === "OLX").length,
      active: activeCount,
      expired: filtered.length - activeCount,
    };
  }

  // Stacked bar by product. Distinct active-holder emails when `countPeople`.
  let productSeries: ProductCell[];
  if (countPeople) {
    const sets = new Map<string, { name: string; Certification: Set<string>; Accreditation: Set<string>; "Instructor-Led Training": Set<string>; OLX: Set<string> }>();
    for (const r of filtered) {
      if (!r.productType || !r.active) continue;
      const key = r.trainingType as ReportType;
      if (!(TYPES as readonly string[]).includes(key)) continue;
      let row = sets.get(r.productType);
      if (!row) {
        row = { name: r.productType, Certification: new Set(), Accreditation: new Set(), "Instructor-Led Training": new Set(), OLX: new Set() };
        sets.set(r.productType, row);
      }
      row[key].add(r.email);
    }
    productSeries = Array.from(sets.values())
      .map((row): ProductCell => ({
        name: row.name,
        Certification: row.Certification.size,
        Accreditation: row.Accreditation.size,
        "Instructor-Led Training": row["Instructor-Led Training"].size,
        OLX: row.OLX.size,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } else {
    const m = new Map<string, ProductCell>();
    for (const r of filtered) {
      if (!r.productType) continue;
      let row = m.get(r.productType);
      if (!row) {
        row = { name: r.productType, Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 };
        m.set(r.productType, row);
      }
      const key = r.trainingType as ReportType;
      if ((TYPES as readonly string[]).includes(key)) row[key]++;
    }
    productSeries = Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

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
  let ordered: ByProductTypeRow[];
  let groups: { key: string; total: number; active: number }[];
  if (groupBy) {
    const grouped = groupRows(sorted, groupBy);
    groups = grouped.map((g) => ({ key: g.key, total: g.rows.length, active: g.rows.filter((r) => r.active).length }));
    ordered = grouped.flatMap((g) => g.rows);
  } else {
    groups = [];
    ordered = sorted;
  }

  const total = ordered.length;
  const rows = all ? ordered : ordered.slice((page - 1) * pageSize, page * pageSize);

  return { charts: { productSeries }, kpis, groups, rows, total, page, pageSize, filterOptions };
}
