/**
 * Shared validation + serialization for ProgramData requirement writes
 * (POST /api/admin/program-data and PUT /api/admin/program-data/[id]).
 *
 * A requirement belongs to a specialisation (specialisationId) and/or a tier
 * (tierId). On a **tiered** program a row may carry neither: that is a
 * **program-wide gate** (`isProgramWideRow`), required by every tier in every
 * deployment mode, and always written with purpose "qualification". On a
 * non-tiered program a row needs at least one of the two. Specialisation-only rows carry a
 * `purpose` ("qualification" earns the specialisation, "deployment" is used by
 * tiers in "perAchievedSpecialisation" mode). Tier rows are always deployment;
 * a tier row may ALSO carry a specialisationId (a "perTierPerSpecialisation"
 * deployment requirement: that tier's deployment certs for that specialisation).
 *
 * A multi-country level (Region, CountrySet, TargetCountries) carries a count mode
 * (`aggregation`): "total" pools distinct holders across the area's countries,
 * "eachCountry" requires every country in the area to reach the quantity on its
 * own. Every other level is always "total" — an explicit "eachCountry" there is
 * a 400 rather than silently dropped, because the author asked for a rule the
 * level cannot express. `minimumPerTheatre` only means anything at Global level
 * and is nulled elsewhere (silently: the engine never reads it there).
 *
 * TargetCountries rows are counted in a program's By Theatre view, over the
 * partner's target countries inside the theatre being viewed. Any program may
 * carry rows at any level.
 */
import prisma from "@/lib/prisma";
import type { ProgramDataRow } from "@/types";
import {
  REQ_LEVELS,
  LEVEL_LABELS,
  isReqLevel,
  isAggregation,
  isMultiCountryLevel,
  normaliseAggregation,
  type Aggregation,
  type ReqLevel,
} from "@/lib/program-levels";

/** The 400 text for a row with neither a specialisation nor a tier on a non-tiered program. */
export const PROGRAM_WIDE_NOT_TIERED_ERROR =
  "A requirement needs a specialisation or a tier, unless the program is tiered (then it can apply at every level)";

export { REQ_LEVELS };

/** Body cap for a single requirement write — one row plus its alternatives,
 *  far below the bulk-import default `readJsonBody` applies. */
export const REQUIREMENT_BODY_MAX_BYTES = 256 * 1024;

/** Longest optional requirement name (`ProgramData.label`) accepted on write. */
export const MAX_REQUIREMENT_LABEL_LENGTH = 120;
export const REQUIREMENT_LABEL_LENGTH_ERROR = `Requirement name must be ${MAX_REQUIREMENT_LABEL_LENGTH} characters or fewer`;

/**
 * Parse an optional requirement name (`ProgramData.label`): absent, null or
 * blank is "no name" (null); a string is trimmed and must fit the length cap;
 * anything else is rejected rather than coerced. Shared by the single-row
 * write routes and the import so both accept exactly the same values.
 */
export function parseRequirementLabel(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "Requirement name must be text" };
  const value = raw.trim();
  if (value === "") return { ok: true, value: null };
  if (value.length > MAX_REQUIREMENT_LABEL_LENGTH) return { ok: false, error: REQUIREMENT_LABEL_LENGTH_ERROR };
  return { ok: true, value };
}

export const REQ_TRAINING_TYPES = ["Certification", "Accreditation", "InstructorLedTraining"] as const;
export const REQ_PURPOSES = ["qualification", "deployment"] as const;

export interface ValidatedRequirement {
  programName: string;
  specialisationId: number | null;
  tierId: number | null;
  purpose: string;
  level: ReqLevel;
  aggregation: Aggregation;
  trainingType: string | null;
  trainingTitle: string | null;
  label: string | null;
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

  const label = parseRequirementLabel(body.label);
  if (!label.ok) return err(label.error);

  const specialisationId = body.specialisationId == null ? null : Number(body.specialisationId);
  const tierId = body.tierId == null ? null : Number(body.tierId);
  if (specialisationId != null && !Number.isInteger(specialisationId)) return err("Invalid specialisation");
  if (tierId != null && !Number.isInteger(tierId)) return err("Invalid tier");
  const hasSpec = specialisationId != null;
  const hasTier = tierId != null;

  // The program's own setting decides whether a row with neither a
  // specialisation nor a tier is allowed (tiered programs only). A program that
  // does not exist yet is created by the POST as a plain, non-tiered program,
  // so it gets the ordinary rules.
  const program = await prisma.program.findUnique({
    where: { name: programName },
    select: { isTiered: true },
  });
  const isProgramWide = !hasSpec && !hasTier;
  if (isProgramWide && !program?.isTiered) {
    return err(PROGRAM_WIDE_NOT_TIERED_ERROR);
  }

  const level = body.level;
  if (!isReqLevel(level)) {
    return err("Valid level is required");
  }

  // Count mode: absent/empty = "total". Anything else must be a known value,
  // and "eachCountry" is only meaningful on a level spanning several countries.
  const aggregationRaw = body.aggregation;
  if (aggregationRaw != null && aggregationRaw !== "") {
    if (!isAggregation(aggregationRaw)) {
      return err('Count mode must be "total" or "eachCountry"');
    }
    if (aggregationRaw === "eachCountry" && !isMultiCountryLevel(level)) {
      return err(
        `The "In each country" count mode is only valid for Region, Country Set or Target countries requirements, not ${LEVEL_LABELS[level]}`,
      );
    }
  }
  const aggregation = normaliseAggregation(level, aggregationRaw);

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
  if (!Number.isInteger(quantityRequired) || quantityRequired < 1) {
    return err("Quantity must be a whole number of at least 1");
  }

  // Only Global requirements are evaluated per theatre; at any other level the
  // value would be stored and never read, so it is dropped.
  const minimumPerTheatre =
    level !== "Global" || body.minimumPerTheatre == null || body.minimumPerTheatre === ""
      ? null
      : Number(body.minimumPerTheatre);
  if (minimumPerTheatre != null && (!Number.isInteger(minimumPerTheatre) || minimumPerTheatre < 0)) {
    return err("Minimum per theatre must be a whole number");
  }

  // Purpose: tier rows are always deployment; specialisation rows default to
  // qualification unless explicitly a deployment requirement; a program-wide
  // gate is always qualification (it gates every tier, whatever the mode).
  let purpose = "qualification";
  if (hasTier) {
    purpose = "deployment";
  } else if (hasSpec && body.purpose === "deployment") {
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
      aggregation,
      trainingType: hasTraining ? trainingType : null,
      trainingTitle: hasTraining ? trainingTitleRaw : null,
      label: label.value,
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
  aggregation: string;
  trainingType: string | null;
  trainingTitle: string | null;
  label: string | null;
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
export function serializeProgramDataRow(record: ProgramDataRecord): ProgramDataRow {
  return {
    id: record.id,
    programName: record.programName,
    specialisationId: record.specialisationId ?? null,
    specialisationName: record.specialisation?.name ?? null,
    tierId: record.tierId ?? null,
    tierName: record.tier?.name ?? null,
    purpose: record.purpose,
    level: record.level,
    // Re-normalised on read so a row can never report a count mode its level
    // cannot carry (the DB CHECK enforces the same rule on write).
    aggregation: normaliseAggregation(record.level, record.aggregation),
    trainingType: record.trainingType ?? null,
    trainingTitle: record.trainingTitle ?? null,
    trainingFullTitle: record.trainingData?.fullTitle ?? "—",
    label: record.label ?? null,
    quantityRequired: record.quantityRequired,
    minimumPerTheatre: record.minimumPerTheatre ?? null,
    alternatives: record.alternatives.map((a) => ({
      trainingType: a.trainingType,
      trainingTitle: a.trainingTitle,
      trainingFullTitle: a.trainingData?.fullTitle ?? "—",
    })),
  };
}

// ---------------------------------------------------------------------------
// Program-level default minimums (shared by the program POST and PATCH routes,
// the program-data import and the partner-settings routes).
// ---------------------------------------------------------------------------

/** Upper bound for a minimum number of countries — far above any real program. */
export const MAX_MINIMUM_COUNTRIES = 1000;

/**
 * Parse a minimum-countries value strictly: a whole number 1–1000 given as a
 * JSON number or a digit-only string. `null` / `""` mean "no minimum". Anything
 * else (fractions, negatives, "6 countries", `true`) is rejected rather than
 * coerced — `Number("")` must never become a minimum of 0.
 */
export function parseMinimumCountries(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw === "string" && raw.trim() === "") return { ok: true, value: null };
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) n = Number(raw.trim());
  else return { ok: false };
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_MINIMUM_COUNTRIES) return { ok: false };
  return { ok: true, value: n };
}

/** The two per-view minimums, and the label each is known by in messages. */
export const MINIMUM_FIELDS = {
  countrySetMinimumCountries: "Minimum countries — By Country Set view",
  targetMinimumCountries: "Minimum target countries — By Theatre view",
} as const;
export type MinimumField = keyof typeof MINIMUM_FIELDS;

export interface ProgramMinimumsInput {
  /** `undefined` = key absent (leave alone); `null` = clear (no default). */
  countrySetMinimumCountries: number | null | undefined;
  /** `undefined` = key absent (leave alone); `null` = clear (no default). */
  targetMinimumCountries: number | null | undefined;
}

/**
 * Read the two per-view default minimums from a program POST/PATCH body. Each
 * key is tri-state: absent = `undefined` (leave the stored value alone);
 * `null` or `""` = clear; otherwise a whole number 1–1000, parsed strictly.
 */
export function parseProgramMinimums(
  body: Record<string, unknown>
): { ok: true; value: ProgramMinimumsInput } | { ok: false; error: string } {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const value: ProgramMinimumsInput = { countrySetMinimumCountries: undefined, targetMinimumCountries: undefined };
  for (const key of Object.keys(MINIMUM_FIELDS) as MinimumField[]) {
    if (!has(key)) continue;
    const parsed = parseMinimumCountries(body[key]);
    if (!parsed.ok) {
      return { ok: false, error: `${MINIMUM_FIELDS[key]}: must be a whole number from 1 to ${MAX_MINIMUM_COUNTRIES}, or blank` };
    }
    value[key] = parsed.value;
  }
  return { ok: true, value };
}

/** Upper bound on a program's included-theatre list (there are only ever a handful). */
export const MAX_INCLUDED_THEATRES = 50;

/**
 * Parse a program's `includedTheatres` from a request body or an import cell
 * list: an array of theatre names (or null = every theatre). Names are trimmed,
 * blanks dropped and duplicates removed; anything that is not a list of strings
 * is refused rather than coerced. Whether each name is a real theatre is checked
 * separately by `unknownTheatres`, which needs the database.
 */
export function parseIncludedTheatres(
  raw: unknown
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) {
    return { ok: false, error: "Theatres included must be a list of theatre names" };
  }
  const value = [...new Set((raw as string[]).map((t) => t.trim()).filter((t) => t.length > 0))];
  if (value.length > MAX_INCLUDED_THEATRES) {
    return { ok: false, error: `Theatres included: at most ${MAX_INCLUDED_THEATRES} theatres` };
  }
  return { ok: true, value };
}

/**
 * The names in `theatres` that no Region Data row carries as its theatre.
 * Region Data is global reference data, so naming them back in an error
 * discloses nothing about any tenant.
 */
export async function unknownTheatres(theatres: string[]): Promise<string[]> {
  if (theatres.length === 0) return [];
  const rows = await prisma.regionData.findMany({
    where: { theatre: { in: theatres } },
    select: { theatre: true },
    distinct: ["theatre"],
  });
  const known = new Set(rows.map((r) => r.theatre));
  return theatres.filter((t) => !known.has(t));
}
