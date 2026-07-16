/**
 * Server-side computation for the Learner Achievement Scorecard
 * (`/api/reports/learner-scorecard`, rendered at `/reports/learner-scorecard`).
 *
 * The report used to fetch three full endpoints (training-records + students +
 * trained-not-certified), roll them up per-learner in the browser, and render
 * one row per learner with no pagination. This module moves the rollup to the
 * server so the browser downloads a small summary (KPIs + leaderboard) plus one
 * page of rows.
 *
 * Parity: `computeFromInputs` is a faithful move of the page's `learners` memo +
 * filters + KPIs + leaderboard + sort. The two toggles (`includeExpired`,
 * `windowMonths`) are parameters, so every number matches the page exactly. Only
 * the detail table is paginated (the accepted UX change).
 */

import prisma from "@/lib/prisma";
import { fetchDedupedTrainingRecords, type DedupedTrainingRecord } from "@/lib/training-records-query";
import { fetchTrainedNotCertified } from "@/lib/report-queries";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ScorecardStudent {
  email: string;
  fullName: string;
  theatre: string | null;
  country: string | null;
  region: string | null;
}

export interface LearnerRow {
  email: string;
  fullName: string;
  theatre: string;
  region: string;
  country: string;
  cert: number;
  accred: number;
  ilt: number;
  olx: number;
  total: number;
  expiring: number;
  lapsed: number;
  gaps: number;
  lastDate: string; // ISO, or "" for learners with no completions
}

export type ScorecardSortKey =
  | "fullName" | "cert" | "accred" | "ilt" | "olx"
  | "total" | "expiring" | "lapsed" | "gaps" | "lastDate";

export interface LearnerScorecardInput {
  companyIds: number[] | null;
  search?: string;
  theatre?: string;
  region?: string;
  country?: string;
  windowMonths?: number;
  includeExpired?: boolean;
  sortKey?: ScorecardSortKey;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  /** When true, return the full filtered+sorted set (for export) and skip paging. */
  all?: boolean;
}

export interface LearnerScorecardResult {
  kpis: { learners: number; achievements: number; withGaps: number; withExpiring: number; zero: number };
  leaderboard: { name: string; total: number }[];
  rows: LearnerRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: { theatres: string[]; regions: string[]; countries: string[] };
}

function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

// ─── Fetch + compute ─────────────────────────────────────────────────────────────

export async function computeLearnerScorecard(input: LearnerScorecardInput): Promise<LearnerScorecardResult> {
  const [studentRows, records, gaps] = await Promise.all([
    prisma.student.findMany({
      where: input.companyIds ? { companyId: { in: input.companyIds } } : {},
      include: { regionData: { select: { region: true } } },
    }),
    fetchDedupedTrainingRecords(input.companyIds),
    fetchTrainedNotCertified(input.companyIds),
  ]);

  const students: ScorecardStudent[] = studentRows.map((s) => ({
    email: s.email,
    fullName: s.fullName,
    theatre: s.theatre,
    country: s.country,
    region: s.regionData?.region ?? null,
  }));
  const gapEmails = gaps.map((g) => g.email);

  return computeFromInputs(students, records, gapEmails, input);
}

/**
 * Pure per-learner rollup + filter + KPIs + leaderboard + sort + paginate. Split
 * from the fetch so it can be parity-tested directly against the old client
 * logic. `now` is injectable for deterministic tests.
 */
export function computeFromInputs(
  students: ScorecardStudent[],
  records: DedupedTrainingRecord[],
  gapEmails: string[],
  input: Omit<LearnerScorecardInput, "companyIds">,
  now: Date = new Date(),
): LearnerScorecardResult {
  const {
    search = "",
    theatre = "",
    region = "",
    country = "",
    windowMonths = 6,
    includeExpired = false,
    sortKey = "total",
    sortDir = "desc",
    all = false,
  } = input;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, input.pageSize ?? 25);
  const windowCutoff = addMonths(now, windowMonths);

  // ── Per-learner aggregation (mirrors the page's `learners` memo) ──
  const map = new Map<string, LearnerRow>();
  const ensure = (email: string, seed: { fullName: string; theatre: string; region: string; country: string }): LearnerRow => {
    let row = map.get(email);
    if (!row) {
      row = {
        email, fullName: seed.fullName, theatre: seed.theatre, region: seed.region, country: seed.country,
        cert: 0, accred: 0, ilt: 0, olx: 0, total: 0, expiring: 0, lapsed: 0, gaps: 0, lastDate: "",
      };
      map.set(email, row);
    }
    return row;
  };

  for (const s of students) {
    ensure(s.email, { fullName: s.fullName, theatre: s.theatre ?? "", region: s.region ?? "", country: s.country ?? "" });
  }

  for (const r of records) {
    const row = ensure(r.email, { fullName: r.fullName, theatre: r.theatre ?? "", region: r.region ?? "", country: r.country ?? "" });

    if (includeExpired || r.active) {
      if (r.trainingType === "Certification") row.cert += 1;
      else if (r.trainingType === "Accreditation") row.accred += 1;
      else if (r.trainingType === "Instructor-Led Training") row.ilt += 1;
      else if (r.trainingType === "OLX") row.olx += 1;
    }

    if (!r.active) row.lapsed += 1;

    if (r.active && (r.trainingType === "Certification" || r.trainingType === "Accreditation") && r.expiryDate) {
      const exp = new Date(r.expiryDate);
      if (exp >= now && exp <= windowCutoff) row.expiring += 1;
    }

    if (r.completedDate && r.completedDate > row.lastDate) row.lastDate = r.completedDate;
  }

  for (const email of gapEmails) {
    const row = map.get(email);
    if (row) row.gaps += 1;
  }

  for (const row of map.values()) {
    row.total = row.cert + row.accred + row.ilt + row.olx;
  }
  const learners = Array.from(map.values());

  // ── Filter options (over all in-scope learners, matching the page) ──
  const filterOptions = {
    theatres: [...new Set(learners.map((l) => l.theatre))].filter(Boolean).sort(),
    regions: [...new Set(learners.map((l) => l.region))].filter(Boolean).sort(),
    countries: [...new Set(learners.map((l) => l.country))].filter(Boolean).sort(),
  };

  // ── Filters ──
  const q = search.trim().toLowerCase();
  const filtered = learners.filter((l) => {
    if (theatre && l.theatre !== theatre) return false;
    if (region && l.region !== region) return false;
    if (country && l.country !== country) return false;
    if (q && !l.fullName.toLowerCase().includes(q) && !l.email.toLowerCase().includes(q)) return false;
    return true;
  });

  // ── KPIs (over filtered) ──
  let achievements = 0, withGaps = 0, withExpiring = 0, zero = 0;
  for (const l of filtered) {
    achievements += l.total;
    if (l.gaps > 0) withGaps += 1;
    if (l.expiring > 0) withExpiring += 1;
    if (l.total === 0) zero += 1;
  }
  const kpis = { learners: filtered.length, achievements, withGaps, withExpiring, zero };

  // ── Leaderboard (top 15 by total among filtered with total>0) ──
  const leaderboard = [...filtered]
    .filter((l) => l.total > 0)
    .sort((a, b) => b.total - a.total || a.fullName.localeCompare(b.fullName))
    .slice(0, 15)
    .map((l) => ({ name: l.fullName, total: l.total }));

  // ── Sort (mirrors the page's comparator) ──
  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === "fullName") {
      return sortDir === "asc" ? a.fullName.localeCompare(b.fullName) : b.fullName.localeCompare(a.fullName);
    }
    if (sortKey === "lastDate") {
      if (!a.lastDate && !b.lastDate) return 0;
      if (!a.lastDate) return 1;
      if (!b.lastDate) return -1;
      return sortDir === "asc" ? a.lastDate.localeCompare(b.lastDate) : b.lastDate.localeCompare(a.lastDate);
    }
    const av = a[sortKey] as number;
    const bv = b[sortKey] as number;
    if (av !== bv) return sortDir === "asc" ? av - bv : bv - av;
    return a.fullName.localeCompare(b.fullName);
  });

  const total = sorted.length;
  const rows = all ? sorted : sorted.slice((page - 1) * pageSize, page * pageSize);

  return { kpis, leaderboard, rows, total, page, pageSize, filterOptions };
}
