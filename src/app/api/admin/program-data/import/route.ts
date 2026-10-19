import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { invalidateReportCache } from "@/lib/report-cache";
import { readJsonBody } from "@/lib/request-body";
import {
  AGGREGATION_SHORT_LABELS,
  LEVEL_LABELS,
  REQ_LEVELS,
  isMultiCountryLevel,
  type Aggregation,
  type ReqLevel,
} from "@/lib/program-levels";
import {
  MAX_INCLUDED_THEATRES,
  MAX_MINIMUM_COUNTRIES,
  PROGRAM_WIDE_NOT_TIERED_ERROR,
  parseMinimumCountries,
  parseProgramDescription,
  parseRequirementLabel,
  unknownTheatres,
} from "@/lib/program-data-write";

/*
 * Program-data import — per-program overwrite (see the page). Two program-level
 * columns ride on every row, like Deployment Handling:
 *  - `Country Set Minimum Countries` — the program's default minimum number of
 *    countries for the By Country Set view (1–1000).
 *  - `Target Minimum Countries` — the program's default minimum number of
 *    target countries for the By Theatre view (1–1000).
 * For both, an unmapped column (key absent) and a blank cell write nothing: the
 * stored value is kept, so a file that predates them imports unchanged.
 * Clearing a minimum is done in the editor, not by import. The first non-blank
 * value in the file wins; a different value on a later row is a warning.
 *
 * A third program-level column, `Included Theatres`, lists the theatres the
 * program operates in (separated by ; | or commas). It follows the same rules,
 * except that the word "All" clears it (every theatre), and every theatre named
 * must exist in Region Data.
 *
 * A fourth, `Program Description`, carries the program's description. It too
 * writes nothing when blank or unmapped (so it is never cleared by import —
 * that is done in the editor) and the first non-blank value wins; a value over
 * the length cap is a row error.
 *
 * Files written while "anchored programs" existed are still accepted:
 *  - `Default Minimum Countries` is read as Target Minimum Countries (it was the
 *    anchored program's minimum target countries) when that cell is blank.
 *  - A non-blank `Anchor Theatre` cell is ignored with a per-row warning, and
 *    that program's Country Set rows are imported as Target countries rows —
 *    the same conversion the database migration applied to stored programs, so
 *    an old export restores the requirements it described.
 *
 * A row with a Level but blank Specialisation AND blank Tier is a
 * **program-wide gate** (required at every tier) when the program is tiered —
 * by a Tier row in the file or by its stored setting — and an error otherwise.
 */

interface RawRow {
  programName?: string;
  specialisationName?: string;
  tierName?: string;
  purpose?: string;
  level?: string;
  /** Count mode for a Region / Country Set row ("Total" | "Each country"). */
  aggregation?: string;
  trainingType?: string;
  trainingFullTitle?: string;
  quantityRequired?: string | number;
  minimumPerTheatre?: string | number | null;
  alternatives?: string;
  /** Optional display name for the rule ("Requirement Name" column). */
  label?: string;
  // Program / tier structure (round-tripped from export)
  deploymentMode?: string;
  tierSortOrder?: string | number | null;
  tierSpecialisationsRequired?: string | number | null;
  // Program-level default minimums (round-tripped from export)
  countrySetMinimumCountries?: string | number | null;
  targetMinimumCountries?: string | number | null;
  /** Program-level: the theatres the program operates in ("All" = every theatre). */
  includedTheatres?: string | null;
  /** Program-level: the program's description ("Program Description" column). */
  description?: string | null;
  // Read for compatibility with files from before the target-countries level.
  anchorTheatre?: string | null;
  defaultMinimumCountries?: string | number | null;
}

// Keyed on the punctuation-stripped lowercase form (see `normalise`), so
// "Country Set", "country_set", "country-set" and "CountrySet" all resolve.
const LEVEL_MAP: Record<string, ReqLevel> = {
  country: "Country",
  region: "Region",
  countryset: "CountrySet",
  targetcountries: "TargetCountries",
  targetcountry: "TargetCountries",
  theatre: "Theatre",
  global: "Global",
};

/** Human list of the levels for error text: "Country, Region, Country Set, Target countries, Theatre, or Global". */
const LEVEL_LIST = (() => {
  const labels = REQ_LEVELS.map((l) => LEVEL_LABELS[l]);
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
})();

// Count-mode cell values, keyed like LEVEL_MAP. Accepts the short labels the
// export writes ("Total" / "Each country"), the long form the editor shows
// ("Total across the area" / "In each country"), the stored values, and a few
// everyday variants.
const AGGREGATION_MAP: Record<string, Aggregation> = {
  total: "total",
  totalacrossthearea: "total",
  pooled: "total",
  eachcountry: "eachCountry",
  ineachcountry: "eachCountry",
  each: "eachCountry",
  percountry: "eachCountry",
};

const DEPLOYMENT_MODES = ["flat", "perAchievedSpecialisation", "perTierPerSpecialisation"];

const NULL_MARKERS = new Set(["—", "-", "–", "n/a", "none", ""]);

function isNullMarker(val: string): boolean {
  return NULL_MARKERS.has(val.trim().toLowerCase());
}

const TRAINING_TYPE_MAP: Record<string, string> = {
  certification: "Certification",
  cert: "Certification",
  accreditation: "Accreditation",
  accred: "Accreditation",
  instructorledtraining: "InstructorLedTraining",
  "instructor-led training": "InstructorLedTraining",
  "instructorled": "InstructorLedTraining",
  ilt: "InstructorLedTraining",
  "instructor led training": "InstructorLedTraining",
};

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveLevel(raw: string): ReqLevel | null {
  return LEVEL_MAP[normalise(raw)] ?? null;
}

/** Resolve a Count Mode cell. Blank / a null marker means "total"; an
 *  unrecognised value is `undefined` (a per-row error, never a silent default). */
function resolveAggregation(raw: string): Aggregation | undefined {
  if (raw.trim() === "" || isNullMarker(raw)) return "total";
  return AGGREGATION_MAP[normalise(raw)];
}

function resolveTrainingType(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  // Try direct normalised map
  const normalised = normalise(raw.trim());
  if (TRAINING_TYPE_MAP[key]) return TRAINING_TYPE_MAP[key];
  if (TRAINING_TYPE_MAP[normalised]) return TRAINING_TYPE_MAP[normalised];
  // Already valid canonical value
  if (["Certification", "Accreditation", "InstructorLedTraining"].includes(raw.trim())) return raw.trim();
  return null;
}

/** Match a deployment mode label/value (case- and punctuation-insensitive). */
function resolveDeploymentMode(raw: string): string | null {
  const key = normalise(raw);
  if (!key) return null;
  return DEPLOYMENT_MODES.find((m) => normalise(m) === key) ?? null;
}

/** Parse an optional non-negative integer cell; null when absent/invalid. */
function parseOptionalInt(val: string | number | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (s === "" || isNullMarker(s)) return null;
  const n = typeof val === "number" ? val : parseInt(s, 10);
  return !isNaN(n) && n >= 0 ? n : null;
}

/** A validated, resolved row ready to write. `requirement` is null for a pure
 *  tier-definition row (registers a tier's structure without a ProgramData row)
 *  and for a program-settings row (registers the program and its minimums). */
interface ResolvedRow {
  programName: string;
  deploymentMode: string | null;
  tierName: string | null;
  tierSortOrder: number | null;
  tierSpecialisationsRequired: number | null;
  requirement: {
    specialisationName: string | null;
    purpose: string;
    level: ReqLevel;
    aggregation: Aggregation;
    trainingType: "Certification" | "Accreditation" | "InstructorLedTraining" | null;
    trainingTitle: string | null;
    label: string | null;
    quantityRequired: number;
    minimumPerTheatre: number | null;
    altData: { trainingType: string; trainingTitle: string }[];
  } | null;
}

type ValidateResult =
  | { ok: true; value: ResolvedRow; warnings: string[] }
  | { ok: false; message: string };

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const rows: RawRow[] = body.rows ?? [];

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "No rows provided" }, { status: 400 });
  }
  if (rows.length > 10_000) {
    return NextResponse.json(
      { error: "Too many rows in a single import (max 10,000)." },
      { status: 413 }
    );
  }

  // Pre-fetch training data (fullTitle → trainingTitle) for resolution
  const allTrainings = await prisma.trainingData.findMany({
    select: { trainingTitle: true, fullTitle: true, trainingType: true },
  });
  // Build a map: normalised fullTitle → best trainingTitle match
  // Multiple trainingTitles can share a fullTitle — pick the first (consistent with rest of app)
  const fullTitleMap = new Map<string, { trainingTitle: string; trainingType: string }>();
  for (const t of allTrainings) {
    const key = normalise(t.fullTitle);
    if (!fullTitleMap.has(key)) {
      fullTitleMap.set(key, { trainingTitle: t.trainingTitle, trainingType: t.trainingType });
    }
  }

  // --- Program-level pre-pass: tiered-ness and default minimums per program ---
  // A program-wide gate needs a tiered program, and whether a program is
  // tiered comes from the whole file (a Tier row anywhere) plus the database,
  // so it is resolved before any row is validated. The default minimums ride
  // on every row and the first non-blank value wins, so they are gathered here
  // too, as are the legacy anchor cells that convert a program's Country Set
  // rows (see the header).
  const cellText = (v: unknown): string =>
    v === null || v === undefined ? "" : typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";

  type MinCell = { kind: "blank" } | { kind: "ok"; value: number; column: string } | { kind: "bad"; message: string };
  const MIN_COLUMNS = {
    countrySet: "Country Set Minimum Countries",
    target: "Target Minimum Countries",
  } as const;
  type MinKey = keyof typeof MIN_COLUMNS;
  const parseMinCell = (raw: unknown, column: string): MinCell => {
    const m = cellText(raw);
    if (!m || isNullMarker(m)) return { kind: "blank" };
    const parsedMin = parseMinimumCountries(m);
    return parsedMin.ok && parsedMin.value !== null
      ? { kind: "ok", value: parsedMin.value, column }
      : { kind: "bad", message: `${column} "${m.slice(0, 20)}" must be a whole number from 1 to ${MAX_MINIMUM_COUNTRIES}` };
  };
  const minCells: Record<MinKey, MinCell[]> = { countrySet: [], target: [] };
  const fileMinimum: Record<MinKey, Map<string, number>> = { countrySet: new Map(), target: new Map() };
  /** Rows whose (legacy) Anchor Theatre cell is non-blank. */
  const anchorRows = new Set<number>();
  /** Programs a non-blank Anchor Theatre names somewhere in the file: their Country Set rows convert. */
  const convertedPrograms = new Set<string>();
  const fileTiered = new Set<string>();
  // Included Theatres: a program-level cell like the minimums — the first
  // non-blank value per program wins, a blank or unmapped cell writes nothing,
  // and "All" clears it (every theatre). Names split on ; | or comma.
  type TheatreCell = { kind: "blank" } | { kind: "ok"; value: string[]; text: string };
  const theatreCells: TheatreCell[] = [];
  const fileTheatres = new Map<string, string[]>();
  const parseTheatreCell = (raw: unknown): TheatreCell => {
    const text = cellText(raw);
    if (!text || isNullMarker(text)) return { kind: "blank" };
    if (text.toLowerCase() === "all") return { kind: "ok", value: [], text };
    const value = [...new Set(text.split(/[;|,\n]/).map((t) => t.trim()).filter(Boolean))].sort();
    return { kind: "ok", value, text };
  };
  // Program Description: blank or unmapped writes nothing; the first non-blank
  // value per program wins.
  type DescriptionCell = { kind: "blank" } | { kind: "ok"; value: string } | { kind: "bad"; message: string };
  const descriptionCells: DescriptionCell[] = [];
  const fileDescriptions = new Map<string, string>();
  const parseDescriptionCell = (raw: unknown): DescriptionCell => {
    const text = cellText(raw);
    if (!text || isNullMarker(text)) return { kind: "blank" };
    const parsedDescription = parseProgramDescription(text);
    if (!parsedDescription.ok) return { kind: "bad", message: `Program ${parsedDescription.error}` };
    return parsedDescription.value === null ? { kind: "blank" } : { kind: "ok", value: parsedDescription.value };
  };
  rows.forEach((raw, index) => {
    const program = raw?.programName?.trim() ?? "";

    const descriptionCell = parseDescriptionCell(raw?.description);
    descriptionCells.push(descriptionCell);
    if (program && descriptionCell.kind === "ok" && !fileDescriptions.has(program)) {
      fileDescriptions.set(program, descriptionCell.value);
    }

    const theatreCell = parseTheatreCell(raw?.includedTheatres);
    theatreCells.push(theatreCell);
    if (program && theatreCell.kind === "ok" && !fileTheatres.has(program)) fileTheatres.set(program, theatreCell.value);

    const csCell = parseMinCell(raw?.countrySetMinimumCountries, MIN_COLUMNS.countrySet);
    // The legacy Default Minimum Countries column was the anchored program's
    // minimum target countries; it stands in only where the new cell is blank.
    const newTarget = cellText(raw?.targetMinimumCountries);
    const targetCell =
      newTarget && !isNullMarker(newTarget)
        ? parseMinCell(raw?.targetMinimumCountries, MIN_COLUMNS.target)
        : parseMinCell(raw?.defaultMinimumCountries, `Default Minimum Countries (read as ${MIN_COLUMNS.target})`);
    minCells.countrySet.push(csCell);
    minCells.target.push(targetCell);
    if (program && csCell.kind === "ok" && !fileMinimum.countrySet.has(program)) fileMinimum.countrySet.set(program, csCell.value);
    if (program && targetCell.kind === "ok" && !fileMinimum.target.has(program)) fileMinimum.target.set(program, targetCell.value);

    const anchor = cellText(raw?.anchorTheatre);
    if (anchor && !isNullMarker(anchor)) {
      anchorRows.add(index);
      if (program) convertedPrograms.add(program);
    }

    const tier = cellText(raw?.tierName);
    if (program && tier && !isNullMarker(tier)) fileTiered.add(program);
  });
  // Every theatre a cell names must be a Region Data theatre (global
  // reference data, so naming an unknown one back is safe).
  const unknownTheatreSet = new Set(
    await unknownTheatres([...new Set(theatreCells.flatMap((c) => (c.kind === "ok" ? c.value : [])))])
  );
  const fileProgramNames = [...new Set(rows.map((r) => r?.programName?.trim() ?? "").filter(Boolean))];
  const storedPrograms = fileProgramNames.length
    ? await prisma.program.findMany({
        where: { name: { in: fileProgramNames } },
        select: { name: true, isTiered: true },
      })
    : [];
  const storedByName = new Map(storedPrograms.map((p) => [p.name, p]));
  const effectiveTiered = (program: string): boolean =>
    fileTiered.has(program) || (storedByName.get(program)?.isTiered ?? false);

  /** Validate + resolve a single raw row (no DB writes). */
  function validateRow(raw: RawRow, index: number): ValidateResult {
    const programName = raw.programName?.trim() ?? "";
    const specialisationName = isNullMarker(raw.specialisationName?.trim() ?? "") ? "" : (raw.specialisationName?.trim() ?? "");
    const tierName = isNullMarker(raw.tierName?.trim() ?? "") ? "" : (raw.tierName?.trim() ?? "");
    const purpose = raw.purpose?.trim().toLowerCase() === "deployment" ? "deployment" : "qualification";
    const rawLevel = raw.level?.trim() ?? "";
    const rawAggregation = String(raw.aggregation ?? "").trim();
    const rawTrainingType = isNullMarker(raw.trainingType?.trim() ?? "") ? "" : (raw.trainingType?.trim() ?? "");
    const rawTrainingFullTitle = isNullMarker(raw.trainingFullTitle?.trim() ?? "") ? "" : (raw.trainingFullTitle?.trim() ?? "");
    const rawQty = raw.quantityRequired;
    const rawMinPerTheatre = raw.minimumPerTheatre;
    const rawAlternatives = raw.alternatives?.trim() ?? "";

    if (!programName) return { ok: false, message: "Program Name is required" };

    // A blank cell or a dash means "no name", exactly as the single-row write
    // routes treat an empty value; the length rule is the same shared one.
    const rawLabel = String(raw.label ?? "").trim();
    const parsedLabel = parseRequirementLabel(isNullMarker(rawLabel) ? null : rawLabel);
    if (!parsedLabel.ok) return { ok: false, message: parsedLabel.error };

    const programWarnings: string[] = [];
    let hasMinimum = false;
    for (const key of Object.keys(MIN_COLUMNS) as MinKey[]) {
      const cell = minCells[key][index];
      if (cell.kind === "bad") return { ok: false, message: cell.message };
      if (cell.kind !== "ok") continue;
      hasMinimum = true;
      const first = fileMinimum[key].get(programName);
      if (cell.value !== first) {
        programWarnings.push(`${cell.column} ${cell.value} ignored — an earlier row set it to ${first}`);
      }
    }
    const theatreCell = theatreCells[index];
    if (theatreCell.kind === "ok") {
      const unknown = theatreCell.value.filter((t) => unknownTheatreSet.has(t));
      if (unknown.length > 0) return { ok: false, message: `Included Theatres: unknown theatre ${unknown.join(", ")}` };
      if (theatreCell.value.length > MAX_INCLUDED_THEATRES) {
        return { ok: false, message: `Included Theatres: at most ${MAX_INCLUDED_THEATRES} theatres` };
      }
      hasMinimum = true;
      const first = fileTheatres.get(programName) ?? [];
      if (first.join("|") !== theatreCell.value.join("|")) {
        programWarnings.push(
          `Included Theatres "${theatreCell.text.slice(0, 60)}" ignored — an earlier row set ${first.length ? first.join(", ") : "All"}`
        );
      }
    }
    const descriptionCell = descriptionCells[index];
    if (descriptionCell.kind === "bad") return { ok: false, message: descriptionCell.message };
    if (descriptionCell.kind === "ok") {
      hasMinimum = true;
      if (descriptionCell.value !== fileDescriptions.get(programName)) {
        programWarnings.push("Program Description ignored — an earlier row set a different description");
      }
    }
    const hasAnchorCell = anchorRows.has(index);
    if (hasAnchorCell) {
      programWarnings.push("Anchor Theatre ignored — that setting has been retired (this program's Country Set rows import as Target countries rows)");
    }

    const hasSpec = specialisationName !== "";
    const hasTier = tierName !== "";
    const hasTraining = rawTrainingFullTitle !== "";
    // A row names a Specialisation and/or a Tier (both together is a
    // per-tier-per-specialisation deployment requirement), or — on a tiered
    // program — neither, which is a program-wide gate. A row with neither and
    // nothing else in it is still an error rather than a silent no-op.
    const isProgramWide = !hasSpec && !hasTier;
    if (isProgramWide && !rawLevel && !hasTraining) {
      // A program-settings row: names only the program and its default
      // minimums (the export writes one for a program that has minimums but no
      // requirements or tiers, so they survive the round-trip). It registers
      // the program and nothing else. An old file's anchor-only row registers
      // the program too, with the warning above.
      if (hasMinimum || hasAnchorCell) {
        return {
          ok: true,
          value: {
            programName,
            deploymentMode: resolveDeploymentMode(raw.deploymentMode?.trim() ?? ""),
            tierName: null,
            tierSortOrder: null,
            tierSpecialisationsRequired: null,
            requirement: null,
          },
          warnings: programWarnings,
        };
      }
      return { ok: false, message: "Provide a Specialisation and/or a Tier" };
    }
    if (isProgramWide && !effectiveTiered(programName)) {
      return { ok: false, message: PROGRAM_WIDE_NOT_TIERED_ERROR };
    }

    // Program-/tier-structure columns (round-tripped from export).
    const deploymentMode = resolveDeploymentMode(raw.deploymentMode?.trim() ?? "");
    const tierSortOrder = parseOptionalInt(raw.tierSortOrder);
    const tierSpecialisationsRequired = parseOptionalInt(raw.tierSpecialisationsRequired);

    // A pure tier-definition row (tier named, no specialisation, no training)
    // only records the tier's structure — it creates no ProgramData requirement.
    if (hasTier && !hasSpec && !hasTraining) {
      return {
        ok: true,
        value: {
          programName,
          deploymentMode,
          tierName,
          tierSortOrder,
          tierSpecialisationsRequired,
          requirement: null,
        },
        warnings: programWarnings,
      };
    }

    if (!rawLevel) return { ok: false, message: "Level is required" };
    const statedLevel = resolveLevel(rawLevel);
    if (!statedLevel) return { ok: false, message: `Unknown level "${rawLevel}". Use: ${LEVEL_LIST}` };
    // An old file's anchored program counted its Country Set rows over the
    // partner's target countries — exactly what Target countries rows do now.
    const converted = statedLevel === "CountrySet" && convertedPrograms.has(programName);
    const level: ReqLevel = converted ? "TargetCountries" : statedLevel;

    const aggregation = resolveAggregation(rawAggregation);
    if (!aggregation) {
      return {
        ok: false,
        message: `Unknown Count Mode "${rawAggregation}". Use: ${AGGREGATION_SHORT_LABELS.total} or ${AGGREGATION_SHORT_LABELS.eachCountry}`,
      };
    }
    if (aggregation === "eachCountry" && !isMultiCountryLevel(level)) {
      return {
        ok: false,
        message: `Count Mode "${AGGREGATION_SHORT_LABELS.eachCountry}" is only valid for Region, Country Set or Target countries rows, not ${LEVEL_LABELS[level]}`,
      };
    }
    const warnings: string[] = [...programWarnings];
    if (converted) {
      warnings.push(
        "Country Set row imported as a Target countries row — this program's rows name an Anchor Theatre, a retired setting whose Country Set rows counted the partner's target countries"
      );
    }

    const quantityRequired = typeof rawQty === "number" ? rawQty : parseInt(String(rawQty ?? ""), 10);
    if (isNaN(quantityRequired) || quantityRequired < 1) {
      return { ok: false, message: "Quantity Required must be a number ≥ 1" };
    }

    let minimumPerTheatre: number | null = null;
    if (rawMinPerTheatre !== null && rawMinPerTheatre !== undefined && String(rawMinPerTheatre).trim() !== "" && !isNullMarker(String(rawMinPerTheatre))) {
      // Strict: a present-but-unparseable value is an error, never a silent
      // null (parseInt would also have truncated "2.5" to 2).
      const text = String(rawMinPerTheatre).trim();
      const parsed = typeof rawMinPerTheatre === "number" ? rawMinPerTheatre : /^\d+$/.test(text) ? Number(text) : NaN;
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { ok: false, message: `Minimum per Theatre "${text}" must be a whole number ≥ 0` };
      }
      minimumPerTheatre = parsed;
    }
    // Minimum per Theatre is only evaluated for Global requirements; at any
    // other level it would be stored and never read, so it is dropped — with a
    // warning, since the file asked for something that will not happen.
    if (minimumPerTheatre !== null && level !== "Global") {
      warnings.push(`Minimum per Theatre ignored — it only applies to Global rows, not ${LEVEL_LABELS[level]}`);
      minimumPerTheatre = null;
    }

    let resolvedTrainingTitle: string | null = null;
    let resolvedTrainingType: "Certification" | "Accreditation" | "InstructorLedTraining" | null = null;

    if (hasTraining) {
      if (!rawTrainingType) return { ok: false, message: "Training Type is required when Training is specified" };
      const rt = resolveTrainingType(rawTrainingType);
      if (!rt) return { ok: false, message: `Unknown Training Type "${rawTrainingType}". Use: Certification, Accreditation, or ILT` };
      resolvedTrainingType = rt as "Certification" | "Accreditation" | "InstructorLedTraining";

      const trainingMatch = fullTitleMap.get(normalise(rawTrainingFullTitle));
      if (!trainingMatch) return { ok: false, message: `Training "${rawTrainingFullTitle}" not found in the training catalog` };
      resolvedTrainingTitle = trainingMatch.trainingTitle;
    } else if (level !== "Global" || hasTier) {
      // Non-global rows must have training; tier deployment requirements always
      // name a training (they can't be the "count compliant theatres" placeholder).
      return { ok: false, message: "Training Type and Training are required for every non-Global row and for tier deployment requirements" };
    }
    // Global + no training = "count compliant theatres" mode (allowed)

    // --- Resolve alternatives (pipe-separated training names) ---
    const altData: { trainingType: string; trainingTitle: string }[] = [];
    if (rawAlternatives && !isNullMarker(rawAlternatives)) {
      const altNames = rawAlternatives.split("|").map((s: string) => s.trim()).filter(Boolean);
      for (const altName of altNames) {
        const altMatch = fullTitleMap.get(normalise(altName));
        if (!altMatch) return { ok: false, message: `Alternative training "${altName}" not found in the training catalog` };
        altData.push({ trainingType: altMatch.trainingType, trainingTitle: altMatch.trainingTitle });
      }
    }

    return {
      ok: true,
      value: {
        programName,
        deploymentMode,
        tierName: hasTier ? tierName : null,
        tierSortOrder,
        tierSpecialisationsRequired,
        requirement: {
          specialisationName: hasSpec ? specialisationName : null,
          // Tier rows are deployment; a program-wide gate is always qualification.
          purpose: hasTier ? "deployment" : isProgramWide ? "qualification" : purpose,
          level,
          aggregation,
          trainingType: resolvedTrainingType,
          trainingTitle: resolvedTrainingTitle,
          label: parsedLabel.value,
          quantityRequired,
          minimumPerTheatre,
          altData,
        },
      },
      warnings,
    };
  }

  // --- Validation pass: collect resolved rows + per-row errors ---
  const errors: { row: number; message: string }[] = [];
  const warnings: { row: number; message: string }[] = [];
  const resolved: ResolvedRow[] = [];
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const result = validateRow(rows[i], i);
    if (!result.ok) {
      errors.push({ row: i + 1, message: result.message });
      skipped++;
      continue;
    }
    resolved.push(result.value);
    for (const message of result.warnings) warnings.push({ row: i + 1, message });
  }

  if (dryRun) {
    // In dry-run mode, "created" = number of rows that would succeed
    return NextResponse.json({ created: resolved.length, skipped, errors, warnings });
  }

  // Programs named in this file are overwritten: their existing requirements are
  // replaced (not merged) so re-importing an edited export never duplicates rows.
  const programNames = [...new Set(resolved.map((r) => r.programName))];

  // Per-program deployment mode + per-tier metadata (first non-null wins; export
  // repeats these on every row so they're consistent within a program/tier).
  const programDeploymentMode = new Map<string, string>();
  const programIsTiered = new Set<string>();
  const tierMeta = new Map<string, { program: string; tierName: string; sortOrder: number | null; specialisationsRequired: number | null }>();
  const tierKey = (program: string, tier: string) => JSON.stringify([program, tier.toLowerCase()]);
  for (const r of resolved) {
    if (r.deploymentMode && !programDeploymentMode.has(r.programName)) {
      programDeploymentMode.set(r.programName, r.deploymentMode);
    }
    if (r.tierName) {
      programIsTiered.add(r.programName);
      const key = tierKey(r.programName, r.tierName);
      const existing = tierMeta.get(key);
      tierMeta.set(key, {
        program: r.programName,
        tierName: existing?.tierName ?? r.tierName,
        sortOrder: existing?.sortOrder ?? r.tierSortOrder,
        specialisationsRequired: existing?.specialisationsRequired ?? r.tierSpecialisationsRequired,
      });
    }
  }

  let created = 0;

  await prisma.$transaction(
    async (tx) => {
      // 1. Replace: wipe the affected programs' existing requirements.
      //    ProgramDataAlternative cascades via its FK. Program + tier rows are kept.
      await tx.programData.deleteMany({ where: { programName: { in: programNames } } });

      // 2. Register programs (persist as admin cards; apply tiered flag + mode).
      for (const name of programNames) {
        const mode = programDeploymentMode.get(name);
        const isTiered = programIsTiered.has(name);
        // Blank / unmapped minimum columns write nothing (see the header).
        const countrySetMinimumCountries = fileMinimum.countrySet.get(name);
        const targetMinimumCountries = fileMinimum.target.get(name);
        const includedTheatres = fileTheatres.get(name);
        const description = fileDescriptions.get(name);
        const minimumData = {
          ...(description !== undefined ? { description } : {}),
          ...(countrySetMinimumCountries !== undefined ? { countrySetMinimumCountries } : {}),
          ...(targetMinimumCountries !== undefined ? { targetMinimumCountries } : {}),
          ...(includedTheatres !== undefined ? { includedTheatres } : {}),
        };
        await tx.program.upsert({
          where: { name },
          create: { name, isTiered, ...(mode ? { deploymentMode: mode } : {}), ...minimumData },
          update: {
            ...(isTiered ? { isTiered: true } : {}),
            ...(mode ? { deploymentMode: mode } : {}),
            ...minimumData,
          },
        });
      }

      // 3. Resolve tiers (create if missing, apply metadata from the file).
      const tierIdCache = new Map<string, number>();
      for (const [key, meta] of tierMeta) {
        const program = meta.program;
        const tierName = meta.tierName;

        let tier = await tx.programTier.findUnique({
          where: { programName_name: { programName: program, name: tierName } },
        });
        if (!tier) {
          let sortOrder = meta.sortOrder;
          if (sortOrder === null) {
            const max = await tx.programTier.aggregate({ where: { programName: program }, _max: { sortOrder: true } });
            sortOrder = (max._max.sortOrder ?? 0) + 1;
          }
          tier = await tx.programTier.create({
            data: {
              programName: program,
              name: tierName,
              sortOrder,
              specialisationsRequired: meta.specialisationsRequired ?? 1,
            },
          });
        } else if (meta.sortOrder !== null || meta.specialisationsRequired !== null) {
          tier = await tx.programTier.update({
            where: { id: tier.id },
            data: {
              ...(meta.sortOrder !== null ? { sortOrder: meta.sortOrder } : {}),
              ...(meta.specialisationsRequired !== null ? { specialisationsRequired: meta.specialisationsRequired } : {}),
            },
          });
        }
        tierIdCache.set(key, tier.id);
      }

      // 4. Resolve specialisations (create if missing).
      const specIdCache = new Map<string, number>();
      const specNames = [
        ...new Set(resolved.map((r) => r.requirement?.specialisationName).filter((n): n is string => !!n)),
      ];
      for (const name of specNames) {
        let spec = await tx.specialisation.findFirst({ where: { name } });
        if (!spec) spec = await tx.specialisation.create({ data: { name } });
        specIdCache.set(name.toLowerCase(), spec.id);
      }

      // 5. Create the requirement rows.
      for (const r of resolved) {
        if (!r.requirement) continue; // tier-definition-only row
        const req = r.requirement;
        const tierId = r.tierName ? tierIdCache.get(tierKey(r.programName, r.tierName)) ?? null : null;
        const specId = req.specialisationName ? specIdCache.get(req.specialisationName.toLowerCase()) ?? null : null;

        await tx.programData.create({
          data: {
            programName: r.programName,
            specialisationId: specId,
            tierId,
            purpose: req.purpose,
            level: req.level,
            aggregation: req.aggregation,
            trainingType: req.trainingType,
            trainingTitle: req.trainingTitle,
            label: req.label,
            quantityRequired: req.quantityRequired,
            minimumPerTheatre: req.minimumPerTheatre,
            alternatives: req.altData.length > 0 ? {
              create: req.altData.map((a) => ({
                trainingType: a.trainingType as "Certification" | "Accreditation" | "InstructorLedTraining",
                trainingTitle: a.trainingTitle,
              })),
            } : undefined,
          },
        });
        created++;
      }
    },
    { timeout: 120_000, maxWait: 10_000 }
  );

  invalidateReportCache();

  await prisma.importMetadata.upsert({
    where: { key: "program-data" },
    update: { timestamp: new Date() },
    create: { key: "program-data", timestamp: new Date() },
  });

  return NextResponse.json({ created, skipped, errors, warnings });
}
