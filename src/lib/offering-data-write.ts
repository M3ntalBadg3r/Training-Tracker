/**
 * Shared validation + serialization for OfferingData requirement writes
 * (POST /api/admin/offering-data and PUT /api/admin/offering-data/[id]).
 *
 * An offering requirement always belongs to a specialisation and names the
 * supporting training (Certification / Accreditation / Instructor-Led Training /
 * OLX) that a partner must hold to deliver it, with a minimum required count and
 * optional alternatives (OR logic). Unlike ProgramData there is no level,
 * purpose or tier — geography (Onshore/Nearshore/Offshore) is applied at view time.
 */
import prisma from "@/lib/prisma";

// Offerings additionally allow OLX (parents) beyond the three Programs use.
export const OFFERING_TRAINING_TYPES = [
  "Certification",
  "Accreditation",
  "InstructorLedTraining",
  "OLX",
] as const;

export interface ValidatedOfferingRequirement {
  offeringId: number;
  /** The company that owns the offering — used by routes for canAccessCompany. */
  companyId: number;
  specialisationId: number;
  trainingType: string;
  trainingTitle: string;
  quantityRequired: number;
  altData: { trainingType: string; trainingTitle: string }[];
}

export type OfferingValidationResult =
  | { ok: true; value: ValidatedOfferingRequirement }
  | { ok: false; error: string; status: number };

/** Validate an offering requirement request body (shared by create + update). */
export async function validateOfferingRequirementBody(
  body: Record<string, unknown>
): Promise<OfferingValidationResult> {
  const err = (error: string, status = 400): OfferingValidationResult => ({ ok: false, error, status });

  const offeringId = body.offeringId == null ? NaN : Number(body.offeringId);
  if (Number.isNaN(offeringId)) return err("An offering is required");

  const specialisationId = body.specialisationId == null ? NaN : Number(body.specialisationId);
  if (Number.isNaN(specialisationId)) return err("A specialisation is required");

  const trainingTitle = typeof body.trainingTitle === "string" ? body.trainingTitle.trim() : "";
  const trainingType = typeof body.trainingType === "string" ? body.trainingType : "";
  if (!OFFERING_TRAINING_TYPES.includes(trainingType as (typeof OFFERING_TRAINING_TYPES)[number])) {
    return err("Valid training type is required");
  }
  if (!trainingTitle) return err("Training is required");

  const quantityRequired = Number(body.quantityRequired);
  if (!quantityRequired || quantityRequired < 1) return err("Quantity must be at least 1");

  // Existence checks.
  const spec = await prisma.specialisation.findUnique({ where: { id: specialisationId } });
  if (!spec) return err("Specialisation not found", 404);
  const offering = await prisma.offering.findUnique({ where: { id: offeringId } });
  if (!offering) return err("Offering not found", 404);
  const training = await prisma.trainingData.findUnique({ where: { trainingTitle } });
  if (!training) return err("Training not found", 404);

  const altData: { trainingType: string; trainingTitle: string }[] = [];
  if (Array.isArray(body.alternatives) && body.alternatives.length > 0) {
    for (const alt of body.alternatives as Array<{ trainingType?: string; trainingTitle?: string }>) {
      if (
        !alt.trainingType ||
        !OFFERING_TRAINING_TYPES.includes(alt.trainingType as (typeof OFFERING_TRAINING_TYPES)[number])
      ) {
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
      offeringId,
      companyId: offering.companyId,
      specialisationId,
      trainingType,
      trainingTitle,
      quantityRequired,
      altData,
    },
  };
}

/** Shape of an OfferingData record with the relations needed for serialization. */
export interface OfferingDataRecord {
  id: number;
  offeringId: number;
  specialisationId: number;
  trainingType: string | null;
  trainingTitle: string | null;
  quantityRequired: number;
  offering: { name: string; companyId: number } | null;
  specialisation: { name: string } | null;
  trainingData: { fullTitle: string } | null;
  alternatives: { trainingType: string; trainingTitle: string; trainingData: { fullTitle: string } | null }[];
}

/** The include clause that produces an OfferingDataRecord. */
export const offeringDataInclude = {
  offering: { select: { name: true, companyId: true } },
  specialisation: { select: { name: true } },
  trainingData: { select: { fullTitle: true } },
  alternatives: { include: { trainingData: { select: { fullTitle: true } } } },
} as const;

/** Serialize an OfferingData record to the camelCase API row shape. */
export function serializeOfferingDataRow(record: OfferingDataRecord) {
  return {
    id: record.id,
    offeringId: record.offeringId,
    offeringName: record.offering?.name ?? "—",
    companyId: record.offering?.companyId ?? null,
    specialisationId: record.specialisationId,
    specialisationName: record.specialisation?.name ?? null,
    trainingType: record.trainingType ?? null,
    trainingTitle: record.trainingTitle ?? null,
    trainingFullTitle: record.trainingData?.fullTitle ?? "—",
    quantityRequired: record.quantityRequired,
    alternatives: record.alternatives.map((a) => ({
      trainingType: a.trainingType,
      trainingTitle: a.trainingTitle,
      trainingFullTitle: a.trainingData?.fullTitle ?? "—",
    })),
  };
}
