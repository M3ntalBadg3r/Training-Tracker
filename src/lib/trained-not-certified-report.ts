/**
 * Server-side computation for the Trained But Not Certified report
 * (`/api/reports/trained-not-certified`, rendered at `/reports/trained-not-certified`).
 *
 * The report used to ship the entire gap dataset to the browser and
 * filter/aggregate/render it client-side (charts + KPIs + every row via
 * GroupedRows, no pagination). This module moves that work to the server so the
 * browser downloads only a small summary plus one page of rows.
 *
 * `fetchTrainedNotCertifiedRows` is the (unchanged) base query that used to live
 * inline in the route; `computeTrainedNotCertified` layers the page's exact
 * filter/sort/group/pagination on top of it.
 */

import prisma from "@/lib/prisma";
import { groupRows, type GroupByMode } from "@/lib/group-by";
import { resolveBucket } from "@/lib/group-by";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface TrainedNotCertifiedRow {
  fullName: string;
  email: string;
  theatre: string;
  region: string;
  country: string;
  iltFullTitle: string;
  iltProductType: string;
  certificationFullTitle: string;
  iltCompletedDate: string;
  iltActive: boolean;
}

export interface TrainedNotCertifiedInput {
  companyIds: number[] | null;
  search?: string;
  theatre?: string;
  region?: string;
  country?: string;
  product?: string;
  ilt?: string;
  cert?: string;
  active?: string;
  groupBy?: GroupByMode | null;
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  all?: boolean;
}

export interface TrainedNotCertifiedResult {
  charts: {
    productSeries: { name: string; "ILT Completed": number; "ILT Still Active": number }[];
    bucketSeries: { name: string; count: number }[];
  };
  kpis: { total: number; activeIlt: number; distinctStudents: number; distinctIlts: number };
  groups: { key: string; total: number; active: number }[];
  rows: TrainedNotCertifiedRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: {
    theatres: string[];
    regions: string[];
    countries: string[];
    productTypes: string[];
    iltTitles: string[];
    certTitles: string[];
  };
}

// ─── Base query (extracted from the old route, unchanged) ────────────────────────

export async function fetchTrainedNotCertifiedRows(
  companyFilter: number[] | null,
): Promise<TrainedNotCertifiedRow[]> {
  // Find all ILT and OLX trainings that have at least one certification mapping.
  // OLX parents are treated identically to ILT here — completion of an OLX (all
  // sub-items done) materialises a TrainingTaken row on the parent, so the
  // existing query logic works unchanged.
  const iltWithCert = await prisma.trainingData.findMany({
    where: {
      trainingType: { in: ["InstructorLedTraining", "OLX"] },
      certification: { isEmpty: false },
    },
    include: { productType: { select: { name: true } } },
  });

  if (iltWithCert.length === 0) return [];

  const certTitles = new Set<string>();
  for (const ilt of iltWithCert) {
    for (const cert of ilt.certification) certTitles.add(cert);
  }

  const certData = await prisma.trainingData.findMany({
    where: { trainingTitle: { in: Array.from(certTitles) } },
  });
  const certFullTitleMap = new Map(certData.map((c: typeof certData[number]) => [c.trainingTitle, c.fullTitle]));

  const results: TrainedNotCertifiedRow[] = [];
  const now = new Date();

  for (const ilt of iltWithCert) {
    if (ilt.certification.length === 0) continue;

    const iltRecords = await prisma.trainingTaken.findMany({
      where: {
        trainingTitle: ilt.trainingTitle,
        ...(companyFilter ? { student: { companyId: { in: companyFilter } } } : {}),
      },
      select: { email: true, completedDate: true, expiryDate: true },
    });

    if (iltRecords.length === 0) continue;

    const iltByEmail = new Map<string, { completedDate: Date; expiryDate: Date }>();
    for (const rec of iltRecords) {
      const existing = iltByEmail.get(rec.email);
      if (!existing || rec.completedDate > existing.completedDate) {
        iltByEmail.set(rec.email, { completedDate: rec.completedDate, expiryDate: rec.expiryDate });
      }
    }

    const iltEmails = Array.from(iltByEmail.keys());

    // A training can map to multiple certifications (alternatives, OR): a student
    // is only "not certified" if they hold NONE of them.
    const certStudents = await prisma.trainingTaken.findMany({
      where: { trainingTitle: { in: ilt.certification }, email: { in: iltEmails } },
      select: { email: true },
      distinct: ["email"],
    });

    const certifiedEmails = new Set(certStudents.map((s: typeof certStudents[number]) => s.email));
    const uncertifiedEmails = iltEmails.filter((e) => !certifiedEmails.has(e));

    if (uncertifiedEmails.length === 0) continue;

    const students = await prisma.student.findMany({
      where: { email: { in: uncertifiedEmails } },
      include: { regionData: true },
    });

    const iltFull = ilt.fullTitle;
    const iltProduct = ilt.productType.name;
    const certFull = ilt.certification.map((c: string) => certFullTitleMap.get(c) || c).join(" or ");

    for (const student of students) {
      const iltRecord = iltByEmail.get(student.email)!;
      results.push({
        fullName: student.fullName,
        email: student.email,
        theatre: student.theatre,
        region: student.regionData?.region || "",
        country: student.country,
        iltFullTitle: iltFull,
        iltProductType: iltProduct,
        certificationFullTitle: certFull,
        iltCompletedDate: iltRecord.completedDate.toISOString(),
        iltActive: iltRecord.expiryDate > now,
      });
    }
  }

  results.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return results;
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

const SORT_ACCESSORS: Record<string, (r: TrainedNotCertifiedRow) => SortValue> = {
  fullName: (r) => r.fullName,
  email: (r) => r.email,
  theatre: (r) => r.theatre,
  region: (r) => r.region,
  country: (r) => r.country,
  iltFullTitle: (r) => r.iltFullTitle,
  iltProductType: (r) => r.iltProductType,
  iltCompletedDate: (r) => r.iltCompletedDate,
  iltActive: (r) => r.iltActive,
  certificationFullTitle: (r) => r.certificationFullTitle,
};

// ─── Main compute ────────────────────────────────────────────────────────────────

export async function computeTrainedNotCertified(
  input: TrainedNotCertifiedInput,
): Promise<TrainedNotCertifiedResult> {
  const rows = await fetchTrainedNotCertifiedRows(input.companyIds);
  return computeFromRows(rows, input);
}

export function computeFromRows(
  data: TrainedNotCertifiedRow[],
  input: Omit<TrainedNotCertifiedInput, "companyIds">,
): TrainedNotCertifiedResult {
  const {
    search = "",
    theatre = "",
    region = "",
    country = "",
    product = "",
    ilt = "",
    cert = "",
    active = "",
    groupBy = null,
    sortColumn = "fullName",
    sortDir = "asc",
    all = false,
  } = input;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, input.pageSize ?? 25);

  // Dropdown options come from the full in-scope set (matches the page).
  const filterOptions = {
    theatres: [...new Set(data.map((r) => r.theatre))].filter(Boolean).sort(),
    regions: [...new Set(data.map((r) => r.region))].filter(Boolean).sort(),
    countries: [...new Set(data.map((r) => r.country))].filter(Boolean).sort(),
    productTypes: [...new Set(data.map((r) => r.iltProductType))].filter(Boolean).sort(),
    iltTitles: [...new Set(data.map((r) => r.iltFullTitle))].sort(),
    certTitles: [...new Set(data.flatMap((r) => r.certificationFullTitle.split(" or ")))].filter(Boolean).sort(),
  };

  // The exact `filteredData` predicate from the page.
  const q = search.toLowerCase();
  const filtered = data.filter((r) => {
    const matchesSearch = !search || r.fullName.toLowerCase().includes(q) || r.email.toLowerCase().includes(q);
    const matchesTheatre = !theatre || r.theatre === theatre;
    const matchesRegion = !region || r.region === region;
    const matchesCountry = !country || r.country === country;
    const matchesProduct = !product || r.iltProductType === product;
    const matchesIlt = !ilt || r.iltFullTitle === ilt;
    const matchesCert = !cert || r.certificationFullTitle.split(" or ").includes(cert);
    const matchesActive = !active || (active === "yes" ? r.iltActive : !r.iltActive);
    return matchesSearch && matchesTheatre && matchesRegion && matchesCountry && matchesProduct && matchesIlt && matchesCert && matchesActive;
  });

  // Funnel-style chart by product: ILT-completed count + active-ILT count.
  const productMap = new Map<string, { name: string; "ILT Completed": number; "ILT Still Active": number }>();
  for (const r of filtered) {
    let row = productMap.get(r.iltProductType);
    if (!row) {
      row = { name: r.iltProductType, "ILT Completed": 0, "ILT Still Active": 0 };
      productMap.set(r.iltProductType, row);
    }
    row["ILT Completed"]++;
    if (r.iltActive) row["ILT Still Active"]++;
  }
  const productSeries = Array.from(productMap.values()).sort((a, b) => b["ILT Completed"] - a["ILT Completed"]);

  const bucketMap = new Map<string, number>();
  for (const r of filtered) {
    const k = resolveBucket(r, groupBy ?? "theatre");
    bucketMap.set(k, (bucketMap.get(k) ?? 0) + 1);
  }
  const bucketSeries = Array.from(bucketMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const kpis = {
    total: filtered.length,
    activeIlt: filtered.filter((r) => r.iltActive).length,
    distinctStudents: new Set(filtered.map((r) => r.email)).size,
    distinctIlts: new Set(filtered.map((r) => r.iltFullTitle)).size,
  };

  // Sort (empties last, numeric-aware; stable tiebreak on fullName).
  const activeAccessor = SORT_ACCESSORS[sortColumn] ?? SORT_ACCESSORS.fullName;
  const tiebreak = SORT_ACCESSORS.fullName;
  const sorted = [...filtered].sort((a, b) => {
    const primary = compare(activeAccessor(a), activeAccessor(b));
    const signed = sortDir === "asc" ? primary : -primary;
    if (signed !== 0) return signed;
    if (sortColumn !== "fullName") return compare(tiebreak(a), tiebreak(b));
    return 0;
  });

  // Grouping: replicate groupRows(sorted, groupBy) then flatten for pagination.
  let ordered: TrainedNotCertifiedRow[];
  let groups: { key: string; total: number; active: number }[];
  if (groupBy) {
    const grouped = groupRows(sorted, groupBy);
    groups = grouped.map((g) => ({ key: g.key, total: g.rows.length, active: g.rows.filter((r) => r.iltActive).length }));
    ordered = grouped.flatMap((g) => g.rows);
  } else {
    groups = [];
    ordered = sorted;
  }

  const total = ordered.length;
  const paged = all ? ordered : ordered.slice((page - 1) * pageSize, page * pageSize);

  return { charts: { productSeries, bucketSeries }, kpis, groups, rows: paged, total, page, pageSize, filterOptions };
}
