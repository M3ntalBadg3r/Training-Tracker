/**
 * Shared deduped training-records query.
 *
 * Several server-side report aggregators need the same base dataset the
 * `/api/reports/training-records` route produces: every completion in scope,
 * OLX sub-items excluded, deduped to the most-recent row per
 * (email, fullTitle, trainingType), with human-readable labels and ISO date
 * strings. Centralised here so the report modules (expired, learner-scorecard, …)
 * stay in lockstep on exactly how records are fetched and shaped.
 *
 * (The `/api/reports/training-records` route and `report-queries.ts` keep their
 * own copies for now — the former feeds several client consumers directly and
 * the latter returns date-only strings for scheduled exports.)
 */

import prisma from "@/lib/prisma";

/** One deduped completion row — the same shape the training-records route returns. */
export interface DedupedTrainingRecord {
  fullName: string;
  email: string;
  theatre: string;
  region: string;
  country: string;
  trainingTitle: string;
  trainingType: string;
  productType: string;
  function: string;
  completedDate: string;
  expiryDate: string;
  active: boolean;
  isLegacy: boolean;
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

export async function fetchDedupedTrainingRecords(
  companyFilter: number[] | null,
): Promise<DedupedTrainingRecord[]> {
  const rawRecords = await prisma.trainingTaken.findMany({
    where: {
      // OLX sub-items aren't stand-alone completions — they roll up into the
      // parent OLX. Exclude them from completion-counting reports.
      trainingData: { trainingType: { not: "OLXSubItem" } },
      ...(companyFilter ? { student: { companyId: { in: companyFilter } } } : {}),
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

  // Keep one record per student + fullTitle + trainingType (most recent).
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
    trainingType: TYPE_LABELS[tt.trainingData.trainingType] || tt.trainingData.trainingType,
    productType: tt.trainingData.productType.name,
    function: FUNCTION_LABELS[tt.trainingData.function] || tt.trainingData.function,
    completedDate: tt.completedDate.toISOString(),
    expiryDate: tt.expiryDate.toISOString(),
    active: tt.expiryDate > now,
    isLegacy: tt.trainingData.isLegacy,
  }));
}
