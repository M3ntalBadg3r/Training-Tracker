/**
 * Server-side report data fetching functions.
 * Used by the scheduled export executor to fetch report data without going through HTTP.
 */

import prisma from "@/lib/prisma";
import type { ExportColumn } from "@/lib/server-export";
import { computeLegacyGaps } from "@/lib/legacy-gap";

// ─── Type definitions ──────────────────────────────────────────────────────────

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
  iltActive: string;
}

export interface LearnerScorecardRow {
  fullName: string;
  email: string;
  theatre: string;
  region: string;
  country: string;
  certifications: number;
  accreditations: number;
  ilts: number;
  olx: number;
  total: number;
  expiring: number;
  lapsed: number;
  gaps: number;
  lastAchievement: string;
}

export interface LegacyGapRow {
  fullName: string;
  email: string;
  theatre: string;
  region: string;
  country: string;
  legacyFullTitle: string;
  legacyType: string;
  productType: string;
  replacementFullTitle: string;
  legacyCompletedDate: string;
  legacyExpiryDate: string;
  legacyActive: string;
}

export interface TrainingRecordRow {
  fullName: string;
  email: string;
  theatre: string;
  region: string;
  country: string;
  trainingTitle: string;
  trainingType: string;
  // Untransformed trainingType for callers that need to key off the raw
  // enum value (e.g. /training export intersecting with DataTable rows).
  rawTrainingType: string;
  productType: string;
  function: string;
  completedDate: string;
  expiryDate: string;
  active: string;
  isLegacy: boolean;
}

// ─── Shared helpers ─────────────────────────────────────────────────────────────

// Report helpers accept either a single company id (the original scheduled-export
// caller) or a list of ids (the public API, where one key may span several
// companies). `undefined`/`null` means "no company restriction".
export type CompanyScope = number | number[] | null | undefined;

/**
 * Normalise a CompanyScope to either `null` (unrestricted) or an array of ids.
 * An explicit empty array is preserved (and yields no results) so a public API
 * key scoped to a company it can't read fails closed.
 */
function toCompanyIdList(scope: CompanyScope): number[] | null {
  if (scope === null || scope === undefined) return null;
  return Array.isArray(scope) ? scope : [scope];
}

const FUNCTION_LABELS: Record<string, string> = {
  Sales: "Sales",
  PreSales: "Pre-Sales",
  Deployments: "Deployments",
};

const TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
  InstructorLedTraining: "Instructor-Led Training",
  OLX: "OLX",
  OLXSubItem: "OLX Sub-Item",
};

async function fetchAllTrainingRecords(
  companyId?: CompanyScope,
  // Optional lower bound on completedDate, pushed into SQL. Safe to pre-filter
  // ONLY on completedDate: the dedup below keeps the row with the greatest
  // completedDate per (email, fullTitle, type), so narrowing by a completedDate
  // floor can never drop the row dedup would have picked (if the latest is below
  // the floor, the whole group is out either way). Do NOT reuse this for an
  // expiryDate filter — that would let an older expired row survive after the
  // latest active row is filtered out, changing the result.
  completedAfter?: Date,
): Promise<TrainingRecordRow[]> {
  const ids = toCompanyIdList(companyId);
  // OLX sub-items don't represent stand-alone completions — they roll up into
  // their parent OLX once the full set is taken. Exclude them from
  // completion-counting reports.
  const rawRecords = await prisma.trainingTaken.findMany({
    where: {
      trainingData: { trainingType: { not: "OLXSubItem" } },
      ...(completedAfter ? { completedDate: { gte: completedAfter } } : {}),
      ...(ids ? { student: { companyId: { in: ids } } } : {}),
    },
    include: {
      trainingData: {
        select: {
          fullTitle: true,
          trainingType: true,
          productType: { select: { name: true } },
          function: true,
          isLegacy: true,
        },
      },
      student: {
        select: {
          fullName: true,
          theatre: true,
          country: true,
          regionData: { select: { region: true } },
        },
      },
    },
  });

  const dedupeMap = new Map<string, (typeof rawRecords)[number]>();
  for (const tt of rawRecords) {
    const key = `${tt.email}::${tt.trainingData.fullTitle}::${tt.trainingData.trainingType}`;
    const existing = dedupeMap.get(key);
    if (!existing || tt.completedDate > existing.completedDate) {
      dedupeMap.set(key, tt);
    }
  }

  const now = new Date();
  return Array.from(dedupeMap.values()).map((tt) => ({
    fullName: tt.student.fullName,
    email: tt.email,
    theatre: tt.student.theatre,
    region: tt.student.regionData?.region ?? "",
    country: tt.student.country,
    trainingTitle: tt.trainingData.fullTitle,
    trainingType: TYPE_LABELS[tt.trainingData.trainingType] ?? tt.trainingData.trainingType,
    rawTrainingType: tt.trainingData.trainingType,
    productType: tt.trainingData.productType.name,
    function: FUNCTION_LABELS[tt.trainingData.function] ?? tt.trainingData.function,
    completedDate: tt.completedDate.toISOString().split("T")[0],
    expiryDate: tt.expiryDate.toISOString().split("T")[0],
    active: tt.expiryDate > now ? "Yes" : "No",
    isLegacy: tt.trainingData.isLegacy,
  }));
}

export async function fetchTrainingsWithStudents(opts: {
  companyIds?: number[] | null;
  theatre?: string | null;
  region?: string | null;
  country?: string | null;
  activeOnly?: boolean;
}): Promise<TrainingRecordRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const studentWhere: Record<string, any> = {};
  if (opts.theatre) studentWhere.theatre = opts.theatre;
  if (opts.country) studentWhere.country = opts.country;
  if (opts.region) studentWhere.regionData = { region: opts.region };
  if (opts.companyIds && opts.companyIds.length > 0) {
    studentWhere.companyId = { in: opts.companyIds };
  }

  const rawRecords = await prisma.trainingTaken.findMany({
    where: {
      trainingData: { trainingType: { not: "OLXSubItem" } },
      ...(Object.keys(studentWhere).length > 0 ? { student: studentWhere } : {}),
    },
    include: {
      trainingData: {
        select: {
          fullTitle: true,
          trainingType: true,
          productType: { select: { name: true } },
          function: true,
          isLegacy: true,
        },
      },
      student: {
        select: {
          fullName: true,
          theatre: true,
          country: true,
          regionData: { select: { region: true } },
        },
      },
    },
  });

  // Most-recent-per-(email, fullTitle, trainingType) dedup.
  const dedupeMap = new Map<string, (typeof rawRecords)[number]>();
  for (const tt of rawRecords) {
    const key = `${tt.email}::${tt.trainingData.fullTitle}::${tt.trainingData.trainingType}`;
    const existing = dedupeMap.get(key);
    if (!existing || tt.completedDate > existing.completedDate) {
      dedupeMap.set(key, tt);
    }
  }

  const now = new Date();
  let rows = Array.from(dedupeMap.values());
  // Apply activeOnly *after* dedup so "active" means the student's latest
  // completion is still active, not "some older completion was active".
  if (opts.activeOnly) {
    rows = rows.filter((tt) => tt.expiryDate > now);
  }

  return rows.map((tt) => ({
    fullName: tt.student.fullName,
    email: tt.email,
    theatre: tt.student.theatre,
    region: tt.student.regionData?.region ?? "",
    country: tt.student.country,
    trainingTitle: tt.trainingData.fullTitle,
    trainingType: TYPE_LABELS[tt.trainingData.trainingType] ?? tt.trainingData.trainingType,
    rawTrainingType: tt.trainingData.trainingType,
    productType: tt.trainingData.productType.name,
    function: FUNCTION_LABELS[tt.trainingData.function] ?? tt.trainingData.function,
    completedDate: tt.completedDate.toISOString().split("T")[0],
    expiryDate: tt.expiryDate.toISOString().split("T")[0],
    active: tt.expiryDate > now ? "Yes" : "No",
    isLegacy: tt.trainingData.isLegacy,
  }));
}

// ─── Report queries ─────────────────────────────────────────────────────────────

export async function fetchTrainedNotCertified(companyId?: CompanyScope): Promise<TrainedNotCertifiedRow[]> {
  const ids = toCompanyIdList(companyId);
  // Both ILT and OLX trainings can lead to a certification. Treat them
  // identically here — an OLX parent's TrainingTaken row is materialised once
  // the student has completed every sub-item.
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

  // Batch the per-title queries the loop used to run. Instead of 3 queries per
  // cert-bearing ILT/OLX title, fetch all completions, all certification
  // holdings, and all uncertified students in one query each, then group in
  // memory. Results are identical to the per-title version.
  type IltCompletion = { completedDate: Date; expiryDate: Date };

  // 1) All completions for the cert-bearing ILT/OLX titles → most-recent per
  //    (title, email).
  const iltTitles = iltWithCert.map((i) => i.trainingTitle);
  const allIltRecords = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: iltTitles },
      ...(ids ? { student: { companyId: { in: ids } } } : {}),
    },
    select: { trainingTitle: true, email: true, completedDate: true, expiryDate: true },
  });
  const iltByTitle = new Map<string, Map<string, IltCompletion>>();
  for (const rec of allIltRecords) {
    let byEmail = iltByTitle.get(rec.trainingTitle);
    if (!byEmail) {
      byEmail = new Map<string, IltCompletion>();
      iltByTitle.set(rec.trainingTitle, byEmail);
    }
    const existing = byEmail.get(rec.email);
    if (!existing || rec.completedDate > existing.completedDate) {
      byEmail.set(rec.email, { completedDate: rec.completedDate, expiryDate: rec.expiryDate });
    }
  }

  // 2) Holders of every mapped certification, keyed by cert title. No company
  //    filter needed: we only ever consult these for emails that appear in the
  //    (already company-scoped) ILT completions above, and an email maps to a
  //    single student/company.
  const certEmailsByTitle = new Map<string, Set<string>>();
  if (certTitles.size > 0) {
    const certRecords = await prisma.trainingTaken.findMany({
      where: { trainingTitle: { in: Array.from(certTitles) } },
      select: { trainingTitle: true, email: true },
    });
    for (const rec of certRecords) {
      if (!certEmailsByTitle.has(rec.trainingTitle)) certEmailsByTitle.set(rec.trainingTitle, new Set());
      certEmailsByTitle.get(rec.trainingTitle)!.add(rec.email);
    }
  }

  // Per ILT, compute the uncertified holders (in memory) and collect the global
  // set so the student lookup can also be a single query.
  const perIlt: {
    ilt: (typeof iltWithCert)[number];
    uncertifiedEmails: string[];
    iltByEmail: Map<string, IltCompletion>;
  }[] = [];
  const allUncertified = new Set<string>();
  for (const ilt of iltWithCert) {
    if (ilt.certification.length === 0) continue;
    const iltByEmail = iltByTitle.get(ilt.trainingTitle);
    if (!iltByEmail || iltByEmail.size === 0) continue;

    // Certifications mapped to a training are alternatives (OR): a student is
    // only "not certified" if they hold NONE of them.
    const certifiedEmails = new Set<string>();
    for (const cert of ilt.certification) {
      const holders = certEmailsByTitle.get(cert);
      if (holders) for (const e of holders) certifiedEmails.add(e);
    }
    const uncertifiedEmails = Array.from(iltByEmail.keys()).filter((e) => !certifiedEmails.has(e));
    if (uncertifiedEmails.length === 0) continue;

    perIlt.push({ ilt, uncertifiedEmails, iltByEmail });
    for (const e of uncertifiedEmails) allUncertified.add(e);
  }

  if (allUncertified.size === 0) return [];

  // 3) All uncertified students in one query.
  const students = await prisma.student.findMany({
    where: { email: { in: Array.from(allUncertified) } },
    include: { regionData: true },
  });
  const studentMap = new Map(students.map((s: (typeof students)[number]) => [s.email, s]));

  const results: TrainedNotCertifiedRow[] = [];
  const now = new Date();
  for (const { ilt, uncertifiedEmails, iltByEmail } of perIlt) {
    const certFull = ilt.certification.map((c: string) => certFullTitleMap.get(c) ?? c).join(" or ");
    for (const email of uncertifiedEmails) {
      const student = studentMap.get(email);
      if (!student) continue;
      const iltRecord = iltByEmail.get(email)!;
      results.push({
        fullName: student.fullName,
        email: student.email,
        theatre: student.theatre,
        region: student.regionData?.region ?? "",
        country: student.country,
        iltFullTitle: ilt.fullTitle,
        iltProductType: ilt.productType.name,
        certificationFullTitle: certFull,
        iltCompletedDate: iltRecord.completedDate.toISOString().split("T")[0],
        iltActive: iltRecord.expiryDate > now ? "Yes" : "No",
      });
    }
  }

  results.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return results;
}

export async function fetchLegacyGap(companyId?: CompanyScope): Promise<LegacyGapRow[]> {
  // Scheduled-export view uses the report's defaults: active-replacement rule
  // and legacy entries with no replacement included. (The interactive report
  // exposes these as toggles.)
  const records = await computeLegacyGaps(toCompanyIdList(companyId));
  return records.map((r) => ({
    fullName: r.fullName,
    email: r.email,
    theatre: r.theatre,
    region: r.region,
    country: r.country,
    legacyFullTitle: r.legacyFullTitle,
    legacyType: r.legacyType,
    productType: r.productType,
    replacementFullTitle: r.replacementDefined ? r.replacementFullTitle : "None",
    legacyCompletedDate: r.legacyCompletedDate.split("T")[0],
    legacyExpiryDate: r.legacyExpiryDate.split("T")[0],
    legacyActive: r.legacyActive ? "Yes" : "No",
  }));
}

export async function fetchLearnerScorecard(companyId?: CompanyScope): Promise<LearnerScorecardRow[]> {
  const ids = toCompanyIdList(companyId);
  // Seed from the full roster so learners with zero completions still appear
  // (the management half of the report). Counts are active-only and the
  // renewing window is fixed at 6 months to mirror the report's defaults.
  const students = await prisma.student.findMany({
    where: ids ? { companyId: { in: ids } } : {},
    include: { regionData: { select: { region: true } } },
  });

  const map = new Map<string, LearnerScorecardRow>();
  const ensure = (
    email: string,
    seed: { fullName: string; theatre: string; region: string; country: string },
  ): LearnerScorecardRow => {
    let row = map.get(email);
    if (!row) {
      row = {
        email,
        fullName: seed.fullName,
        theatre: seed.theatre,
        region: seed.region,
        country: seed.country,
        certifications: 0, accreditations: 0, ilts: 0, olx: 0, total: 0,
        expiring: 0, lapsed: 0, gaps: 0, lastAchievement: "",
      };
      map.set(email, row);
    }
    return row;
  };

  for (const s of students) {
    ensure(s.email, {
      fullName: s.fullName,
      theatre: s.theatre ?? "",
      region: s.regionData?.region ?? "",
      country: s.country ?? "",
    });
  }

  const records = await fetchAllTrainingRecords(companyId);
  const now = new Date();
  const sixMonths = new Date(now);
  sixMonths.setMonth(sixMonths.getMonth() + 6);

  for (const r of records) {
    const row = ensure(r.email, { fullName: r.fullName, theatre: r.theatre, region: r.region, country: r.country });
    const active = r.active === "Yes";
    if (active) {
      if (r.trainingType === "Certification") row.certifications += 1;
      else if (r.trainingType === "Accreditation") row.accreditations += 1;
      else if (r.trainingType === "Instructor-Led Training") row.ilts += 1;
      else if (r.trainingType === "OLX") row.olx += 1;

      // Expiring Soon = active certs/accreditations expiring within the window.
      if (r.trainingType === "Certification" || r.trainingType === "Accreditation") {
        const exp = new Date(r.expiryDate);
        if (exp >= now && exp <= sixMonths) row.expiring += 1;
      }
    } else {
      row.lapsed += 1;
    }

    if (r.completedDate && r.completedDate > row.lastAchievement) row.lastAchievement = r.completedDate;
  }

  // Certification gaps — one trained-not-certified row per (training, learner).
  const gaps = await fetchTrainedNotCertified(companyId);
  for (const g of gaps) {
    const row = map.get(g.email);
    if (row) row.gaps += 1;
  }

  for (const row of map.values()) {
    row.total = row.certifications + row.accreditations + row.ilts + row.olx;
  }

  return Array.from(map.values()).sort((a, b) => b.total - a.total || a.fullName.localeCompare(b.fullName));
}

export async function fetchByProductType(companyId?: CompanyScope): Promise<TrainingRecordRow[]> {
  const records = await fetchAllTrainingRecords(companyId);
  return records.sort((a, b) => a.productType.localeCompare(b.productType) || a.fullName.localeCompare(b.fullName));
}

export async function fetchByFunction(companyId?: CompanyScope): Promise<TrainingRecordRow[]> {
  const records = await fetchAllTrainingRecords(companyId);
  return records.sort((a, b) => a.function.localeCompare(b.function) || a.fullName.localeCompare(b.fullName));
}

export async function fetchExpiringSoon(monthsAhead = 6, companyId?: CompanyScope): Promise<TrainingRecordRow[]> {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() + monthsAhead);

  const records = await fetchAllTrainingRecords(companyId);
  return records
    .filter((r) => {
      const expiry = new Date(r.expiryDate);
      return expiry >= now && expiry <= cutoff;
    })
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
}

export async function fetchCurrentlyExpired(companyId?: CompanyScope): Promise<TrainingRecordRow[]> {
  const now = new Date();
  const records = await fetchAllTrainingRecords(companyId);
  return records
    .filter((r) => new Date(r.expiryDate) < now)
    .sort((a, b) => b.expiryDate.localeCompare(a.expiryDate)); // most recent lapse first
}

export async function fetchAchievedLast12Months(companyId?: CompanyScope): Promise<TrainingRecordRow[]> {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);

  // Narrow by completedDate in SQL (backed by the training_taken(completed_date)
  // index). Equivalent to filtering after dedup because the dedup keeps the
  // greatest-completedDate row per group — see fetchAllTrainingRecords.
  const records = await fetchAllTrainingRecords(companyId, cutoff);
  return records.sort((a, b) => b.completedDate.localeCompare(a.completedDate));
}

// ─── Column definitions per report ─────────────────────────────────────────────

export const TRAINED_NOT_CERTIFIED_COLUMNS: ExportColumn<TrainedNotCertifiedRow>[] = [
  { key: "fullName", header: "Name" },
  { key: "email", header: "Email" },
  { key: "theatre", header: "Theatre" },
  { key: "region", header: "Region" },
  { key: "country", header: "Country" },
  { key: "iltFullTitle", header: "ILT Title" },
  { key: "iltProductType", header: "Product" },
  { key: "certificationFullTitle", header: "Missing Certification" },
  { key: "iltCompletedDate", header: "ILT Date" },
  { key: "iltActive", header: "Active" },
];

export const LEARNER_SCORECARD_COLUMNS: ExportColumn<LearnerScorecardRow>[] = [
  { key: "fullName", header: "Name" },
  { key: "email", header: "Email" },
  { key: "theatre", header: "Theatre" },
  { key: "region", header: "Region" },
  { key: "country", header: "Country" },
  { key: "certifications", header: "Certifications" },
  { key: "accreditations", header: "Accreditations" },
  { key: "ilts", header: "ILTs" },
  { key: "olx", header: "OLX" },
  { key: "total", header: "Total" },
  { key: "expiring", header: "Expiring Soon (6mo)" },
  { key: "lapsed", header: "Expired" },
  { key: "gaps", header: "Cert Gaps" },
  { key: "lastAchievement", header: "Last Achievement" },
];

export const LEGACY_GAP_COLUMNS: ExportColumn<LegacyGapRow>[] = [
  { key: "fullName", header: "Name" },
  { key: "email", header: "Email" },
  { key: "theatre", header: "Theatre" },
  { key: "region", header: "Region" },
  { key: "country", header: "Country" },
  { key: "legacyFullTitle", header: "Legacy Training" },
  { key: "legacyType", header: "Type" },
  { key: "productType", header: "Product" },
  { key: "replacementFullTitle", header: "Replacement" },
  { key: "legacyCompletedDate", header: "Completed" },
  { key: "legacyExpiryDate", header: "Expires" },
  { key: "legacyActive", header: "Active" },
];

export const TRAINING_RECORD_COLUMNS: ExportColumn<TrainingRecordRow>[] = [
  { key: "fullName", header: "Name" },
  { key: "email", header: "Email" },
  { key: "theatre", header: "Theatre" },
  { key: "country", header: "Country" },
  { key: "trainingTitle", header: "Training" },
  { key: "trainingType", header: "Type" },
  { key: "productType", header: "Product" },
  { key: "function", header: "Function" },
  { key: "completedDate", header: "Completed" },
  { key: "expiryDate", header: "Expires" },
  { key: "active", header: "Active" },
];

// ─── Fetch dispatcher ────────────────────────────────────────────────────────────

export type ReportType =
  | "trained-not-certified"
  | "legacy-gap"
  | "learner-scorecard"
  | "by-product"
  | "by-function"
  | "expiring-soon"
  | "currently-expired"
  | "last-12-months";

export interface ReportResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ExportColumn<any>[];
  title: string;
}

export async function fetchReportData(reportType: ReportType, companyId?: CompanyScope): Promise<ReportResult> {
  switch (reportType) {
    case "trained-not-certified":
      return {
        data: await fetchTrainedNotCertified(companyId),
        columns: TRAINED_NOT_CERTIFIED_COLUMNS,
        title: "Trained But Not Certified",
      };
    case "legacy-gap":
      return {
        data: await fetchLegacyGap(companyId),
        columns: LEGACY_GAP_COLUMNS,
        title: "Legacy Replacement Gap",
      };
    case "learner-scorecard":
      return {
        data: await fetchLearnerScorecard(companyId),
        columns: LEARNER_SCORECARD_COLUMNS,
        title: "Learner Achievement Scorecard",
      };
    case "by-product":
      return {
        data: await fetchByProductType(companyId),
        columns: TRAINING_RECORD_COLUMNS,
        title: "Training Records by Product Type",
      };
    case "by-function":
      return {
        data: await fetchByFunction(companyId),
        columns: TRAINING_RECORD_COLUMNS,
        title: "Training Records by Function",
      };
    case "expiring-soon":
      return {
        data: await fetchExpiringSoon(6, companyId),
        columns: TRAINING_RECORD_COLUMNS,
        title: "Expiring Soon",
      };
    case "currently-expired":
      return {
        data: await fetchCurrentlyExpired(companyId),
        columns: TRAINING_RECORD_COLUMNS,
        title: "Currently Expired",
      };
    case "last-12-months":
      return {
        data: await fetchAchievedLast12Months(companyId),
        columns: TRAINING_RECORD_COLUMNS,
        title: "Achieved in Last 12 Months",
      };
  }
}
