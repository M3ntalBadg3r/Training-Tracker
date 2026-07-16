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

  type Completion = { completedDate: Date; expiryDate: Date };

  // Batch the per-legacy-title queries. Instead of up to 3 queries per legacy
  // training, fetch all legacy holdings, all replacement holdings, and all gap
  // students in one query each, then group in memory. Identical to the per-title
  // version.

  // 1) All legacy-training completions → most-recent per (title, email).
  const legacyTitles = legacyTrainings.map((lt) => lt.trainingTitle);
  const allLegacyRecords = await prisma.trainingTaken.findMany({
    where: { trainingTitle: { in: legacyTitles }, ...companyWhere },
    select: { trainingTitle: true, email: true, completedDate: true, expiryDate: true },
  });
  const legacyByTitle = new Map<string, Map<string, Completion>>();
  for (const rec of allLegacyRecords) {
    let byEmail = legacyByTitle.get(rec.trainingTitle);
    if (!byEmail) {
      byEmail = new Map<string, Completion>();
      legacyByTitle.set(rec.trainingTitle, byEmail);
    }
    const ex = byEmail.get(rec.email);
    if (!ex || rec.completedDate > ex.completedDate) {
      byEmail.set(rec.email, { completedDate: rec.completedDate, expiryDate: rec.expiryDate });
    }
  }

  // 2) All replacement holdings, keyed by replacement title → {any, active}
  //    email sets. No company filter: only ever consulted for legacy-holder
  //    emails (already company-scoped), and an email is one student/company.
  const allReplTitles = new Set<string>();
  for (const lt of legacyTrainings) for (const r of lt.replacedBy) allReplTitles.add(r);
  const replByTitle = new Map<string, { any: Set<string>; active: Set<string> }>();
  if (allReplTitles.size > 0) {
    const replRecords = await prisma.trainingTaken.findMany({
      where: { trainingTitle: { in: Array.from(allReplTitles) } },
      select: { trainingTitle: true, email: true, expiryDate: true },
    });
    for (const rr of replRecords) {
      let entry = replByTitle.get(rr.trainingTitle);
      if (!entry) {
        entry = { any: new Set<string>(), active: new Set<string>() };
        replByTitle.set(rr.trainingTitle, entry);
      }
      entry.any.add(rr.email);
      if (rr.expiryDate > now) entry.active.add(rr.email);
    }
  }

  // Per legacy, compute gap holders in memory and collect the global gap-email
  // set so the student lookup is a single query.
  const perLegacy: {
    lt: (typeof legacyTrainings)[number];
    byEmail: Map<string, Completion>;
    gapEmails: string[];
    anyReplacementEmails: Set<string>;
    replacementDefined: boolean;
    replacementFullTitle: string;
  }[] = [];
  const allGapEmails = new Set<string>();
  for (const lt of legacyTrainings) {
    const byEmail = legacyByTitle.get(lt.trainingTitle);
    if (!byEmail || byEmail.size === 0) continue;
    const emails = Array.from(byEmail.keys());

    // Union replacement holdings (alternatives — any one counts) over this
    // legacy's replacedBy titles.
    const activeReplacementEmails = new Set<string>();
    const anyReplacementEmails = new Set<string>();
    for (const replTitle of lt.replacedBy) {
      const entry = replByTitle.get(replTitle);
      if (!entry) continue;
      for (const e of entry.any) anyReplacementEmails.add(e);
      for (const e of entry.active) activeReplacementEmails.add(e);
    }

    // Gap students = holders without an ACTIVE replacement.
    const gapEmails = emails.filter((e) => !activeReplacementEmails.has(e));
    if (gapEmails.length === 0) continue;

    perLegacy.push({
      lt,
      byEmail,
      gapEmails,
      anyReplacementEmails,
      replacementDefined: lt.replacedBy.length > 0,
      replacementFullTitle: lt.replacedBy.map((r) => replFullTitleMap.get(r) ?? r).join(" or "),
    });
    for (const e of gapEmails) allGapEmails.add(e);
  }

  if (allGapEmails.size === 0) return [];

  const students = await prisma.student.findMany({
    where: { email: { in: Array.from(allGapEmails) } },
    include: { regionData: true },
  });
  const studentMap = new Map(students.map((s) => [s.email, s]));

  for (const { lt, byEmail, gapEmails, anyReplacementEmails, replacementDefined, replacementFullTitle } of perLegacy) {
    for (const email of gapEmails) {
      const student = studentMap.get(email);
      if (!student) continue;
      const rec = byEmail.get(email)!;
      const replacementState: "never" | "expired-only" =
        replacementDefined && anyReplacementEmails.has(email) ? "expired-only" : "never";
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
