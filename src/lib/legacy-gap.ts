/**
 * Shared query for the "Legacy Replacement Gap" report: students who hold a
 * legacy Certification/Accreditation and have not (actively) taken its
 * replacement.
 *
 * A student is dropped entirely once they hold an ACTIVE (non-expired)
 * replacement. Everyone else is returned, annotated so the UI can apply the
 * two user-facing toggles client-side from a single fetch:
 *   - `replacementDefined`  — does the legacy training name a replacement?
 *   - `replacementState`    — "never" (no replacement held) or "expired-only"
 *                             (held a replacement but it has lapsed).
 */

import prisma from "@/lib/prisma";

export interface LegacyGapRecord {
  fullName: string;
  email: string;
  theatre: string;
  region: string;
  country: string;
  legacyTrainingTitle: string;
  legacyFullTitle: string;
  legacyType: string; // "Certification" | "Accreditation"
  productType: string;
  replacementFullTitle: string; // " or "-joined fullTitles, "" when none
  replacementDefined: boolean;
  replacementState: "never" | "expired-only";
  legacyCompletedDate: string; // ISO
  legacyExpiryDate: string; // ISO
  legacyActive: boolean;
}

export async function computeLegacyGaps(
  companyFilter?: number[] | null,
): Promise<LegacyGapRecord[]> {
  const companyWhere = companyFilter && companyFilter.length > 0
    ? { student: { companyId: { in: companyFilter } } }
    : {};
  const legacyTrainings = await prisma.trainingData.findMany({
    where: { isLegacy: true, trainingType: { in: ["Certification", "Accreditation"] } },
    include: { productType: { select: { name: true } } },
  });
  if (legacyTrainings.length === 0) return [];

  // Resolve replacement fullTitles for display.
  const replTitles = new Set<string>();
  for (const lt of legacyTrainings) for (const r of lt.replacedBy) replTitles.add(r);
  const replData = replTitles.size > 0
    ? await prisma.trainingData.findMany({
        where: { trainingTitle: { in: Array.from(replTitles) } },
        select: { trainingTitle: true, fullTitle: true },
      })
    : [];
  const replFullTitleMap = new Map(replData.map((r) => [r.trainingTitle, r.fullTitle]));

  const now = new Date();
  const results: LegacyGapRecord[] = [];

  for (const lt of legacyTrainings) {
    // Holders of the legacy training (most recent completion per email).
    const records = await prisma.trainingTaken.findMany({
      where: {
        trainingTitle: lt.trainingTitle,
        ...companyWhere,
      },
      select: { email: true, completedDate: true, expiryDate: true },
    });
    if (records.length === 0) continue;

    const byEmail = new Map<string, { completedDate: Date; expiryDate: Date }>();
    for (const rec of records) {
      const ex = byEmail.get(rec.email);
      if (!ex || rec.completedDate > ex.completedDate) {
        byEmail.set(rec.email, { completedDate: rec.completedDate, expiryDate: rec.expiryDate });
      }
    }
    const emails = Array.from(byEmail.keys());

    // Replacement holdings (alternatives — any one counts). Track who holds an
    // active replacement (cleared entirely) vs any replacement at all.
    const activeReplacementEmails = new Set<string>();
    const anyReplacementEmails = new Set<string>();
    if (lt.replacedBy.length > 0) {
      const replRecords = await prisma.trainingTaken.findMany({
        where: { trainingTitle: { in: lt.replacedBy }, email: { in: emails } },
        select: { email: true, expiryDate: true },
      });
      for (const rr of replRecords) {
        anyReplacementEmails.add(rr.email);
        if (rr.expiryDate > now) activeReplacementEmails.add(rr.email);
      }
    }

    const replacementDefined = lt.replacedBy.length > 0;
    const replacementFullTitle = lt.replacedBy
      .map((r) => replFullTitleMap.get(r) ?? r)
      .join(" or ");

    // Gap students = holders without an active replacement.
    const gapEmails = emails.filter((e) => !activeReplacementEmails.has(e));
    if (gapEmails.length === 0) continue;

    const students = await prisma.student.findMany({
      where: { email: { in: gapEmails } },
      include: { regionData: true },
    });

    for (const student of students) {
      const rec = byEmail.get(student.email)!;
      const replacementState: "never" | "expired-only" =
        replacementDefined && anyReplacementEmails.has(student.email) ? "expired-only" : "never";
      results.push({
        fullName: student.fullName,
        email: student.email,
        theatre: student.theatre,
        region: student.regionData?.region ?? "",
        country: student.country,
        legacyTrainingTitle: lt.trainingTitle,
        legacyFullTitle: lt.fullTitle,
        legacyType: lt.trainingType,
        productType: lt.productType.name,
        replacementFullTitle,
        replacementDefined,
        replacementState,
        legacyCompletedDate: rec.completedDate.toISOString(),
        legacyExpiryDate: rec.expiryDate.toISOString(),
        legacyActive: rec.expiryDate > now,
      });
    }
  }

  results.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return results;
}
