import prisma from "@/lib/prisma";
import { TrainingType } from "@prisma/client";

const LEGACY_ELIGIBLE: TrainingType[] = ["Certification", "Accreditation"];

/** Only Certifications and Accreditations may be flagged as legacy / replaced. */
export function isLegacyEligible(trainingType: string): boolean {
  return trainingType === "Certification" || trainingType === "Accreditation";
}

/**
 * Normalise the legacy flag + replacement list for a training row.
 * - Non-eligible types are forced to { isLegacy: false, replacedBy: [] }.
 * - When isLegacy is false, replacedBy is cleared.
 * - replacedBy is deduped, self-reference removed, and restricted to existing
 *   Certification/Accreditation training titles.
 */
export async function sanitizeLegacyFields(
  trainingTitle: string,
  trainingType: string,
  isLegacyRaw: unknown,
  replacedByRaw: unknown,
): Promise<{ isLegacy: boolean; replacedBy: string[] }> {
  if (!isLegacyEligible(trainingType) || isLegacyRaw !== true) {
    return { isLegacy: false, replacedBy: [] };
  }

  const candidates = Array.from(
    new Set(
      (Array.isArray(replacedByRaw) ? replacedByRaw : [])
        .filter((x): x is string => typeof x === "string" && !!x.trim())
        .map((x) => x.trim())
        .filter((x) => x !== trainingTitle),
    ),
  );
  if (candidates.length === 0) {
    return { isLegacy: true, replacedBy: [] };
  }

  const valid = await prisma.trainingData.findMany({
    where: { trainingTitle: { in: candidates }, trainingType: { in: LEGACY_ELIGIBLE } },
    select: { trainingTitle: true },
  });
  const validSet = new Set(valid.map((v) => v.trainingTitle));
  return { isLegacy: true, replacedBy: candidates.filter((c) => validSet.has(c)) };
}
