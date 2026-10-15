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
 * A multi-country level (Region, CountrySet) carries a count mode
 * (`aggregation`): "total" pools distinct holders across the area's countries,
 * "eachCountry" requires every country in the area to reach the quantity on its
 * own. Every other level is always "total" — an explicit "eachCountry" there is
 * a 400 rather than silently dropped, because the author asked for a rule the
 * level cannot express. `minimumPerTheatre` only means anything at Global level
 * and is nulled elsewhere (silently: the engine never reads it there).
 *
 * An **anchored** program (`Program.anchorTheatre` set) evaluates only Theatre
 * rows (over the anchor theatre) and Country Set rows (over the partner's
 * target countries), so a write at any other level is a 400 — the row would be
 * stored and never counted.
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
  ANCHORED_REQ_LEVELS,
  isAnchoredReqLevel,
  type Aggregation,
  type ReqLevel,
} from "@/lib/program-levels";

/** The 400 text for a write naming a level an anchored program does not use. */
export function anchoredLevelError(level: string, anchorTheatre: string): string {
  const label = isReqLevel(level) ? LEVEL_LABELS[level] : level;
  const allowed = ANCHORED_REQ_LEVELS.map((l) => LEVEL_LABELS[l]).join(" or ");
  return `This program is anchored to ${anchorTheatre}, so it only uses ${allowed} requirements, not ${label}`;
}

/** The 400 text for a row with neither a specialisation nor a tier on a non-tiered program. */
export const PROGRAM_WIDE_NOT_TIERED_ERROR =
  "A requirement needs a specialisation or a tier, unless the program is tiered (then it can apply at every level)";

export { REQ_LEVELS };

/** Body cap for a single requirement write — one row plus its alternatives,
 *  far below the bulk-import default `readJsonBody` applies. */
export const REQUIREMENT_BODY_MAX_BYTES = 256 * 1024;

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
  if (specialisationId != null && !Number.isInteger(specialisationId)) return err("Invalid specialisation");
  if (tierId != null && !Number.isInteger(tierId)) return err("Invalid tier");
  const hasSpec = specialisationId != null;
  const hasTier = tierId != null;

  // The program's own settings decide two things below: whether a row with
  // neither a specialisation nor a tier is allowed (tiered programs only), and
  // which levels it may use (anchored programs: Theatre / Country Set only).
  // A program that does not exist yet is created by the POST as a plain,
  // non-tiered, non-anchored program, so it gets the ordinary rules.
  const program = await prisma.program.findUnique({
    where: { name: programName },
    select: { isTiered: true, anchorTheatre: true },
  });
  const isProgramWide = !hasSpec && !hasTier;
  if (isProgramWide && !program?.isTiered) {
    return err(PROGRAM_WIDE_NOT_TIERED_ERROR);
  }

  const level = body.level;
  if (!isReqLevel(level)) {
    return err("Valid level is required");
  }
  const anchorTheatre = program?.anchorTheatre?.trim() ? program.anchorTheatre.trim() : null;
  if (anchorTheatre && !isAnchoredReqLevel(level)) {
    return err(anchoredLevelError(level, anchorTheatre));
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
        `The "In each country" count mode is only valid for Region or Country Set requirements, not ${LEVEL_LABELS[level]}`,
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
// Program-level anchor settings (shared by the program POST and PATCH routes).
// ---------------------------------------------------------------------------

/** Upper bound for a minimum number of target countries — far above any real program. */
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

export const MINIMUM_COUNTRIES_ERROR = `Minimum target countries must be a whole number from 1 to ${MAX_MINIMUM_COUNTRIES}`;

/** Every theatre configured in Region Data (non-blank), sorted. */
export async function listConfiguredTheatres(): Promise<string[]> {
  const rows = await prisma.regionData.findMany({
    where: { theatre: { not: null } },
    distinct: ["theatre"],
    select: { theatre: true },
  });
  return rows
    .map((r) => r.theatre?.trim() ?? "")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export interface AnchorSettingsInput {
  /** `undefined` = key absent (leave alone); `null` = clear (not anchored). */
  anchorTheatre: string | null | undefined;
  /** `undefined` = key absent (leave alone); `null` = clear (no default). */
  defaultMinimumCountries: number | null | undefined;
}

/**
 * Read `anchorTheatre` / `defaultMinimumCountries` from a program POST/PATCH
 * body. An absent key is `undefined` (leave the stored value alone); `null` or
 * `""` clears it. The anchor theatre must name a theatre that exists in Region
 * Data (matched exactly, then case-insensitively when unambiguous, and stored
 * in Region Data's spelling) — a misspelt anchor would silently count nobody.
 */
export async function parseAnchorSettings(
  body: Record<string, unknown>
): Promise<{ ok: true; value: AnchorSettingsInput } | { ok: false; error: string }> {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  let anchorTheatre: string | null | undefined;
  if (has("anchorTheatre")) {
    const raw = body.anchorTheatre;
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
      anchorTheatre = null;
    } else if (typeof raw !== "string") {
      return { ok: false, error: "Anchor theatre must be text" };
    } else {
      const wanted = raw.trim();
      const theatres = await listConfiguredTheatres();
      const exact = theatres.find((t) => t === wanted);
      const loose = theatres.filter((t) => t.toLowerCase() === wanted.toLowerCase());
      const match = exact ?? (loose.length === 1 ? loose[0] : undefined);
      if (!match) {
        return { ok: false, error: `Unknown theatre "${wanted.slice(0, 60)}" — choose a theatre from Region Data` };
      }
      anchorTheatre = match;
    }
  }

  let defaultMinimumCountries: number | null | undefined;
  if (has("defaultMinimumCountries")) {
    const parsed = parseMinimumCountries(body.defaultMinimumCountries);
    if (!parsed.ok) return { ok: false, error: MINIMUM_COUNTRIES_ERROR };
    defaultMinimumCountries = parsed.value;
  }

  // Un-anchoring clears the default minimum too unless the request says
  // otherwise: it only means anything on an anchored program, and the admin
  // editor already clears both together, so an API caller sending just
  // `anchorTheatre: null` must end in the same state rather than leave a stale
  // number to resurface on re-anchoring. (Partner settings are kept either way —
  // those are each partner's own terms.)
  if (anchorTheatre === null && defaultMinimumCountries === undefined) {
    defaultMinimumCountries = null;
  }

  return { ok: true, value: { anchorTheatre, defaultMinimumCountries } };
}

/**
 * The warnings an anchored program's editor should see: requirement levels the
 * program has rows at that an anchored view never evaluates. Empty when the
 * program is not anchored.
 */
export async function anchoredLevelWarnings(programName: string, anchorTheatre: string | null): Promise<string[]> {
  if (!anchorTheatre) return [];
  const rows = await prisma.programData.groupBy({
    by: ["level"],
    where: { programName, level: { notIn: [...ANCHORED_REQ_LEVELS] } },
    _count: { _all: true },
  });
  return rows
    .sort((a, b) => REQ_LEVELS.indexOf(a.level as ReqLevel) - REQ_LEVELS.indexOf(b.level as ReqLevel))
    .map((r) => {
      const label = isReqLevel(r.level) ? LEVEL_LABELS[r.level] : r.level;
      const n = r._count._all;
      return `${n} ${label} requirement${n === 1 ? " is" : "s are"} not used now the program is anchored to ${anchorTheatre} — only Theatre and Country Set requirements count`;
    });
}
