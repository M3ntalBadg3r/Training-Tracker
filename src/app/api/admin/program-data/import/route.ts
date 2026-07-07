import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

interface RawRow {
  programName?: string;
  specialisationName?: string;
  tierName?: string;
  purpose?: string;
  level?: string;
  trainingType?: string;
  trainingFullTitle?: string;
  quantityRequired?: string | number;
  minimumPerTheatre?: string | number | null;
  alternatives?: string;
  // Program / tier structure (round-tripped from export)
  deploymentMode?: string;
  tierSortOrder?: string | number | null;
  tierSpecialisationsRequired?: string | number | null;
}

const LEVEL_MAP: Record<string, string> = {
  country: "Country",
  theatre: "Theatre",
  global: "Global",
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

function resolveLevel(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  return LEVEL_MAP[key] ?? null;
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
 *  tier-definition row (registers a tier's structure without a ProgramData row). */
interface ResolvedRow {
  programName: string;
  deploymentMode: string | null;
  tierName: string | null;
  tierSortOrder: number | null;
  tierSpecialisationsRequired: number | null;
  requirement: {
    specialisationName: string | null;
    purpose: string;
    level: "Country" | "Theatre" | "Global";
    trainingType: "Certification" | "Accreditation" | "InstructorLedTraining" | null;
    trainingTitle: string | null;
    quantityRequired: number;
    minimumPerTheatre: number | null;
    altData: { trainingType: string; trainingTitle: string }[];
  } | null;
}

type ValidateResult = { ok: true; value: ResolvedRow } | { ok: false; message: string };

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const body = await request.json();
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

  /** Validate + resolve a single raw row (no DB writes). */
  function validateRow(raw: RawRow): ValidateResult {
    const programName = raw.programName?.trim() ?? "";
    const specialisationName = isNullMarker(raw.specialisationName?.trim() ?? "") ? "" : (raw.specialisationName?.trim() ?? "");
    const tierName = isNullMarker(raw.tierName?.trim() ?? "") ? "" : (raw.tierName?.trim() ?? "");
    const purpose = raw.purpose?.trim().toLowerCase() === "deployment" ? "deployment" : "qualification";
    const rawLevel = raw.level?.trim() ?? "";
    const rawTrainingType = isNullMarker(raw.trainingType?.trim() ?? "") ? "" : (raw.trainingType?.trim() ?? "");
    const rawTrainingFullTitle = isNullMarker(raw.trainingFullTitle?.trim() ?? "") ? "" : (raw.trainingFullTitle?.trim() ?? "");
    const rawQty = raw.quantityRequired;
    const rawMinPerTheatre = raw.minimumPerTheatre;
    const rawAlternatives = raw.alternatives?.trim() ?? "";

    if (!programName) return { ok: false, message: "Program Name is required" };

    const hasSpec = specialisationName !== "";
    const hasTier = tierName !== "";
    // A row must name a Specialisation and/or a Tier. Both together is a
    // per-tier-per-specialisation deployment requirement.
    if (!hasSpec && !hasTier) return { ok: false, message: "Provide a Specialisation and/or a Tier" };

    const hasTraining = rawTrainingFullTitle !== "";

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
      };
    }

    if (!rawLevel) return { ok: false, message: "Level is required" };
    const level = resolveLevel(rawLevel);
    if (!level) return { ok: false, message: `Unknown level "${rawLevel}". Use: Country, Theatre, or Global` };

    const quantityRequired = typeof rawQty === "number" ? rawQty : parseInt(String(rawQty ?? ""), 10);
    if (isNaN(quantityRequired) || quantityRequired < 1) {
      return { ok: false, message: "Quantity Required must be a number ≥ 1" };
    }

    let minimumPerTheatre: number | null = null;
    if (rawMinPerTheatre !== null && rawMinPerTheatre !== undefined && String(rawMinPerTheatre).trim() !== "" && !isNullMarker(String(rawMinPerTheatre))) {
      const parsed = typeof rawMinPerTheatre === "number" ? rawMinPerTheatre : parseInt(String(rawMinPerTheatre), 10);
      if (!isNaN(parsed) && parsed >= 0) minimumPerTheatre = parsed;
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
      // name a training (they can't be the APS "count theatres" placeholder).
      return { ok: false, message: "Training Type and Training are required for Country/Theatre level rows and tier deployment requirements" };
    }
    // Global + no training = APS-style "count compliant theatres" mode (allowed)

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
          purpose: hasTier ? "deployment" : purpose,
          level: level as "Country" | "Theatre" | "Global",
          trainingType: resolvedTrainingType,
          trainingTitle: resolvedTrainingTitle,
          quantityRequired,
          minimumPerTheatre,
          altData,
        },
      },
    };
  }

  // --- Validation pass: collect resolved rows + per-row errors ---
  const errors: { row: number; message: string }[] = [];
  const resolved: ResolvedRow[] = [];
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const result = validateRow(rows[i]);
    if (!result.ok) {
      errors.push({ row: i + 1, message: result.message });
      skipped++;
      continue;
    }
    resolved.push(result.value);
  }

  if (dryRun) {
    // In dry-run mode, "created" = number of rows that would succeed
    return NextResponse.json({ created: resolved.length, skipped, errors });
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
        await tx.program.upsert({
          where: { name },
          create: { name, isTiered, ...(mode ? { deploymentMode: mode } : {}) },
          update: {
            ...(isTiered ? { isTiered: true } : {}),
            ...(mode ? { deploymentMode: mode } : {}),
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
            trainingType: req.trainingType,
            trainingTitle: req.trainingTitle,
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

  return NextResponse.json({ created, skipped, errors });
}
