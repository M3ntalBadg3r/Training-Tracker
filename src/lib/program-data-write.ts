/**
 * Shared validation + serialization for ProgramData requirement writes
 * (POST /api/admin/program-data and PUT /api/admin/program-data/[id]).
 *
 * A requirement belongs to EITHER a specialisation (specialisationId) OR a tier
 * (tierId) — exactly one. Specialisation rows carry a `purpose`
 * ("qualification" earns the specialisation, "deployment" is used by tiers in
 * "perAchievedSpecialisation" mode); tier rows are always deployment.
 */
import prisma from "@/lib/prisma";

export const REQ_TRAINING_TYPES = ["Certification", "Accreditation", "InstructorLedTraining"] as const;
export const REQ_LEVELS = ["Country", "Theatre", "Global"] as const;
export const REQ_PURPOSES = ["qualification", "deployment"] as const;

export interface ValidatedRequirement {
  programName: string;
  specialisationId: number | null;
  tierId: number | null;
  purpose: string;
  level: string;
  trainingType: string | null;
  trainingTitle: string | null;
  quantityRequired: number;
  minimumPerTheatre: number | null;
  altData: { trainingType: string; trainingTitle: string }[];
}

export type ValidationResult =
  | { ok: true; value: ValidatedRequirement }
  | { ok: false; error: string; status: number };

/** Validate a requirement request body (shared by create + update). */
export async function validateRequirementBody(body: Record<string, unknown>): Promise<ValidationResult> {
  const err = (error: string, status = 400): ValidationResult => ({ ok: false, error, status });

  const programName = typeof body.programName === "string" ? body.programName.trim() : "";
  if (!programName) return err("Program name is required");

  const specialisationId = body.specialisationId == null ? null : Number(body.specialisationId);
  const tierId = body.tierId == null ? null : Number(body.tierId);
  const hasSpec = specialisationId != null && !Number.isNaN(specialisationId);
  const hasTier = tierId != null && !Number.isNaN(tierId);
  if (hasSpec === hasTier) {
    return err("Requirement must belong to either a specialisation or a tier");
  }

  const level = typeof body.level === "string" ? body.level : "";
  if (!REQ_LEVELS.includes(level as (typeof REQ_LEVELS)[number])) {
    return err("Valid level is required");
  }

  const trainingTitleRaw = typeof body.trainingTitle === "string" ? body.trainingTitle : "";
  const trainingType = typeof body.trainingType === "string" ? body.trainingType : "";
  const hasTraining = trainingTitleRaw.trim() !== "";
  if (level !== "Global" || hasTraining) {
    if (!REQ_TRAINING_TYPES.includes(trainingType as (typeof REQ_TRAINING_TYPES)[number])) {
      return err("Valid training type is required");
    }
    if (!hasTraining) return err("Training is required");
  }

  const quantityRequired = Number(body.quantityRequired);
  if (!quantityRequired || quantityRequired < 1) return err("Quantity must be at least 1");

  const minimumPerTheatre =
    body.minimumPerTheatre == null || body.minimumPerTheatre === "" ? null : Number(body.minimumPerTheatre);

  // Purpose: tier rows are always deployment; specialisation rows default to
  // qualification unless explicitly a deployment requirement.
  let purpose = "qualification";
  if (hasTier) {
    purpose = "deployment";
  } else if (body.purpose === "deployment") {
    purpose = "deployment";
  }

  // Existence checks.
  if (hasSpec) {
    const spec = await prisma.specialisation.findUnique({ where: { id: specialisationId! } });
    if (!spec) return err("Specialisation not found", 404);
  }
  if (hasTier) {
    const tier = await prisma.programTier.findUnique({ where: { id: tierId! } });
    if (!tier) return err("Tier not found", 404);
  }
  if (hasTraining) {
    const training = await prisma.trainingData.findUnique({ where: { trainingTitle: trainingTitleRaw } });
    if (!training) return err("Training not found", 404);
  }

  const altData: { trainingType: string; trainingTitle: string }[] = [];
  if (Array.isArray(body.alternatives) && body.alternatives.length > 0) {
    for (const alt of body.alternatives as Array<{ trainingType?: string; trainingTitle?: string }>) {
      if (!alt.trainingType || !REQ_TRAINING_TYPES.includes(alt.trainingType as (typeof REQ_TRAINING_TYPES)[number])) {
        return err("Each alternative must have a valid training type");
      }
      if (!alt.trainingTitle?.trim()) {
        return err("Each alternative must have a training selected");
      }
      const altTraining = await prisma.trainingData.findUnique({ where: { trainingTitle: alt.trainingTitle } });
      if (!altTraining) return err(`Alternative training "${alt.trainingTitle}" not found`, 404);
      altData.push({ trainingType: alt.trainingType, trainingTitle: alt.trainingTitle });
    }
  }

  return {
    ok: true,
    value: {
      programName,
      specialisationId: hasSpec ? specialisationId! : null,
      tierId: hasTier ? tierId! : null,
      purpose,
      level,
      trainingType: hasTraining ? trainingType : null,
      trainingTitle: hasTraining ? trainingTitleRaw : null,
      quantityRequired,
      minimumPerTheatre,
      altData,
    },
  };
}

/** Shape of a ProgramData record with the relations needed for serialization. */
export interface ProgramDataRecord {
  id: number;
  programName: string;
  specialisationId: number | null;
  tierId: number | null;
  purpose: string;
  level: string;
  trainingType: string | null;
  trainingTitle: string | null;
  quantityRequired: number;
  minimumPerTheatre: number | null;
  specialisation: { name: string } | null;
  tier: { name: string } | null;
  trainingData: { fullTitle: string } | null;
  alternatives: { trainingType: string; trainingTitle: string; trainingData: { fullTitle: string } | null }[];
}

/** The include clause that produces a ProgramDataRecord. */
export const programDataInclude = {
  specialisation: true,
  tier: { select: { name: true } },
  trainingData: { select: { fullTitle: true } },
  alternatives: { include: { trainingData: { select: { fullTitle: true } } } },
} as const;

/** Serialize a ProgramData record to the camelCase API row shape. */
export function serializeProgramDataRow(record: ProgramDataRecord) {
  return {
    id: record.id,
    programName: record.programName,
    specialisationId: record.specialisationId ?? null,
    specialisationName: record.specialisation?.name ?? null,
    tierId: record.tierId ?? null,
    tierName: record.tier?.name ?? null,
    purpose: record.purpose,
    level: record.level,
    trainingType: record.trainingType ?? null,
    trainingTitle: record.trainingTitle ?? null,
    trainingFullTitle: record.trainingData?.fullTitle ?? "—",
    quantityRequired: record.quantityRequired,
    minimumPerTheatre: record.minimumPerTheatre ?? null,
    alternatives: record.alternatives.map((a) => ({
      trainingType: a.trainingType,
      trainingTitle: a.trainingTitle,
      trainingFullTitle: a.trainingData?.fullTitle ?? "—",
    })),
  };
}
