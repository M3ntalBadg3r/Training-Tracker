/**
 * Server-side report data fetching functions.
 * Used by the scheduled export executor to fetch report data without going through HTTP.
 */

import prisma from "@/lib/prisma";
import type { ExportColumn } from "@/lib/server-export";

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

export interface TrainingRecordRow {
  fullName: string;
  email: string;
  theatre: string;
  country: string;
  trainingTitle: string;
  trainingType: string;
  productType: string;
  function: string;
  completedDate: string;
  expiryDate: string;
  active: string;
}

// ─── Shared helpers ─────────────────────────────────────────────────────────────

const FUNCTION_LABELS: Record<string, string> = {
  Sales: "Sales",
  PreSales: "Pre-Sales",
  Deployments: "Deployments",
};

const TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
  InstructorLedTraining: "Instructor-Led Training",
};

async function fetchAllTrainingRecords(): Promise<TrainingRecordRow[]> {
  const rawRecords = await prisma.trainingTaken.findMany({
    include: {
      trainingData: {
        select: {
          fullTitle: true,
          trainingType: true,
          productType: true,
          function: true,
        },
      },
      student: {
        select: { fullName: true, theatre: true, country: true },
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
    country: tt.student.country,
    trainingTitle: tt.trainingData.fullTitle,
    trainingType: TYPE_LABELS[tt.trainingData.trainingType] ?? tt.trainingData.trainingType,
    productType: tt.trainingData.productType,
    function: FUNCTION_LABELS[tt.trainingData.function] ?? tt.trainingData.function,
    completedDate: tt.completedDate.toISOString().split("T")[0],
    expiryDate: tt.expiryDate.toISOString().split("T")[0],
    active: tt.expiryDate > now ? "Yes" : "No",
  }));
}

// ─── Report queries ─────────────────────────────────────────────────────────────

export async function fetchTrainedNotCertified(): Promise<TrainedNotCertifiedRow[]> {
  const iltWithCert = await prisma.trainingData.findMany({
    where: { trainingType: "InstructorLedTraining", certification: { isEmpty: false } },
  });
  if (iltWithCert.length === 0) return [];

  const certTitles = new Set<string>();
  for (const ilt of iltWithCert) {
    for (const cert of ilt.certification) certTitles.add(cert);
  }

  const certData = await prisma.trainingData.findMany({
    where: { trainingTitle: { in: Array.from(certTitles) } },
  });
  const certFullTitleMap = new Map(certData.map((c) => [c.trainingTitle, c.fullTitle]));

  const results: TrainedNotCertifiedRow[] = [];
  const now = new Date();

  for (const ilt of iltWithCert) {
    if (ilt.certification.length === 0) continue;

    const iltRecords = await prisma.trainingTaken.findMany({
      where: { trainingTitle: ilt.trainingTitle },
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

    for (const certTitle of ilt.certification) {
      const certStudents = await prisma.trainingTaken.findMany({
        where: { trainingTitle: certTitle, email: { in: iltEmails } },
        select: { email: true },
        distinct: ["email"],
      });

      const certifiedEmails = new Set(certStudents.map((s) => s.email));
      const uncertifiedEmails = iltEmails.filter((e) => !certifiedEmails.has(e));
      if (uncertifiedEmails.length === 0) continue;

      const students = await prisma.student.findMany({
        where: { email: { in: uncertifiedEmails } },
        include: { regionData: true },
      });

      const certFull = certFullTitleMap.get(certTitle) ?? certTitle;

      for (const student of students) {
        const iltRecord = iltByEmail.get(student.email)!;
        results.push({
          fullName: student.fullName,
          email: student.email,
          theatre: student.theatre,
          region: student.regionData?.region ?? "",
          country: student.country,
          iltFullTitle: ilt.fullTitle,
          iltProductType: ilt.productType,
          certificationFullTitle: certFull,
          iltCompletedDate: iltRecord.completedDate.toISOString().split("T")[0],
          iltActive: iltRecord.expiryDate > now ? "Yes" : "No",
        });
      }
    }
  }

  results.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return results;
}

export async function fetchByProductType(): Promise<TrainingRecordRow[]> {
  const records = await fetchAllTrainingRecords();
  return records.sort((a, b) => a.productType.localeCompare(b.productType) || a.fullName.localeCompare(b.fullName));
}

export async function fetchByFunction(): Promise<TrainingRecordRow[]> {
  const records = await fetchAllTrainingRecords();
  return records.sort((a, b) => a.function.localeCompare(b.function) || a.fullName.localeCompare(b.fullName));
}

export async function fetchExpiringSoon(monthsAhead = 6): Promise<TrainingRecordRow[]> {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() + monthsAhead);

  const records = await fetchAllTrainingRecords();
  return records
    .filter((r) => {
      const expiry = new Date(r.expiryDate);
      return expiry >= now && expiry <= cutoff;
    })
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
}

export async function fetchAchievedLast12Months(): Promise<TrainingRecordRow[]> {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);

  const records = await fetchAllTrainingRecords();
  return records
    .filter((r) => new Date(r.completedDate) >= cutoff)
    .sort((a, b) => b.completedDate.localeCompare(a.completedDate));
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
  | "by-product"
  | "by-function"
  | "expiring-soon"
  | "last-12-months";

export interface ReportResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ExportColumn<any>[];
  title: string;
}

export async function fetchReportData(reportType: ReportType): Promise<ReportResult> {
  switch (reportType) {
    case "trained-not-certified":
      return {
        data: await fetchTrainedNotCertified(),
        columns: TRAINED_NOT_CERTIFIED_COLUMNS,
        title: "Trained But Not Certified",
      };
    case "by-product":
      return {
        data: await fetchByProductType(),
        columns: TRAINING_RECORD_COLUMNS,
        title: "Training Records by Product Type",
      };
    case "by-function":
      return {
        data: await fetchByFunction(),
        columns: TRAINING_RECORD_COLUMNS,
        title: "Training Records by Function",
      };
    case "expiring-soon":
      return {
        data: await fetchExpiringSoon(),
        columns: TRAINING_RECORD_COLUMNS,
        title: "Expiring Soon",
      };
    case "last-12-months":
      return {
        data: await fetchAchievedLast12Months(),
        columns: TRAINING_RECORD_COLUMNS,
        title: "Achieved in Last 12 Months",
      };
  }
}
