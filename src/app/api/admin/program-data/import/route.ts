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
}

const LEVEL_MAP: Record<string, string> = {
  country: "Country",
  theatre: "Theatre",
  global: "Global",
};

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

  const errors: { row: number; message: string }[] = [];
  let created = 0;
  let skipped = 0;

  // Specialisation name → id cache (to avoid redundant DB calls)
  const specCache = new Map<string, number>();
  // "programName tierNameLower" → tier id cache
  const tierCache = new Map<string, number>();
  // Programs already registered this run (to avoid redundant upserts)
  const registeredPrograms = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 1;
    const raw = rows[i];

    // --- Required field presence ---
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

    if (!programName) {
      errors.push({ row: rowNum, message: "Program Name is required" });
      skipped++;
      continue;
    }
    const hasSpec = specialisationName !== "";
    const hasTier = tierName !== "";
    if (hasSpec === hasTier) {
      errors.push({ row: rowNum, message: "Provide either a Specialisation or a Tier (exactly one)" });
      skipped++;
      continue;
    }
    if (!rawLevel) {
      errors.push({ row: rowNum, message: "Level is required" });
      skipped++;
      continue;
    }

    // --- Level resolution ---
    const level = resolveLevel(rawLevel);
    if (!level) {
      errors.push({ row: rowNum, message: `Unknown level "${rawLevel}". Use: Country, Theatre, or Global` });
      skipped++;
      continue;
    }

    // --- Quantity ---
    const quantityRequired = typeof rawQty === "number" ? rawQty : parseInt(String(rawQty ?? ""), 10);
    if (isNaN(quantityRequired) || quantityRequired < 1) {
      errors.push({ row: rowNum, message: "Quantity Required must be a number ≥ 1" });
      skipped++;
      continue;
    }

    // --- Minimum per Theatre ---
    let minimumPerTheatre: number | null = null;
    if (rawMinPerTheatre !== null && rawMinPerTheatre !== undefined && String(rawMinPerTheatre).trim() !== "" && !isNullMarker(String(rawMinPerTheatre))) {
      const parsed = typeof rawMinPerTheatre === "number" ? rawMinPerTheatre : parseInt(String(rawMinPerTheatre), 10);
      if (!isNaN(parsed) && parsed >= 0) {
        minimumPerTheatre = parsed;
      }
    }

    // --- Training resolution ---
    const hasTraining = rawTrainingFullTitle !== "";

    let resolvedTrainingTitle: string | null = null;
    let resolvedTrainingType: string | null = null;

    if (hasTraining) {
      // Training type required when training is provided
      if (!rawTrainingType) {
        errors.push({ row: rowNum, message: "Training Type is required when Training is specified" });
        skipped++;
        continue;
      }
      resolvedTrainingType = resolveTrainingType(rawTrainingType);
      if (!resolvedTrainingType) {
        errors.push({ row: rowNum, message: `Unknown Training Type "${rawTrainingType}". Use: Certification, Accreditation, or ILT` });
        skipped++;
        continue;
      }

      // Resolve fullTitle → trainingTitle
      const trainingMatch = fullTitleMap.get(normalise(rawTrainingFullTitle));
      if (!trainingMatch) {
        errors.push({ row: rowNum, message: `Training "${rawTrainingFullTitle}" not found in the training catalog` });
        skipped++;
        continue;
      }
      resolvedTrainingTitle = trainingMatch.trainingTitle;
    } else if (level !== "Global" || hasTier) {
      // Non-global rows must have training; tier deployment requirements always
      // name a training (they can't be the APS "count theatres" placeholder).
      errors.push({ row: rowNum, message: "Training Type and Training are required for Country/Theatre level rows and tier deployment requirements" });
      skipped++;
      continue;
    }
    // Global + no training = APS-style "count compliant theatres" mode (allowed)

    // --- Resolve alternatives (pipe-separated training names) ---
    const altData: { trainingType: string; trainingTitle: string }[] = [];
    if (rawAlternatives && !isNullMarker(rawAlternatives)) {
      const altNames = rawAlternatives.split("|").map((s: string) => s.trim()).filter(Boolean);
      for (const altName of altNames) {
        const altMatch = fullTitleMap.get(normalise(altName));
        if (!altMatch) {
          errors.push({ row: rowNum, message: `Alternative training "${altName}" not found in the training catalog` });
          skipped++;
          break;
        }
        altData.push({ trainingType: altMatch.trainingType, trainingTitle: altMatch.trainingTitle });
      }
      // If we broke out of the loop due to an error, skip this row
      if (altData.length < rawAlternatives.split("|").map((s: string) => s.trim()).filter(Boolean).length) {
        continue;
      }
    }

    if (dryRun) {
      // Validation passed — don't write
      continue;
    }

    // --- Register the program so it persists (incl. as an admin card).
    //     A tier row implies a tiered program. ---
    if (!registeredPrograms.has(programName)) {
      await prisma.program.upsert({
        where: { name: programName },
        create: { name: programName, isTiered: hasTier },
        update: hasTier ? { isTiered: true } : {},
      });
      registeredPrograms.add(programName);
    } else if (hasTier) {
      await prisma.program.update({ where: { name: programName }, data: { isTiered: true } });
    }

    // --- Resolve the requirement's scope (specialisation or tier) ---
    let specId: number | null = null;
    let tierId: number | null = null;
    if (hasTier) {
      const tierKey = `${programName} ${tierName.toLowerCase()}`;
      let cached = tierCache.get(tierKey);
      if (cached === undefined) {
        let tier = await prisma.programTier.findUnique({
          where: { programName_name: { programName, name: tierName } },
        });
        if (!tier) {
          const max = await prisma.programTier.aggregate({ where: { programName }, _max: { sortOrder: true } });
          tier = await prisma.programTier.create({
            data: { programName, name: tierName, sortOrder: (max._max.sortOrder ?? 0) + 1, specialisationsRequired: 1 },
          });
        }
        cached = tier.id;
        tierCache.set(tierKey, cached);
      }
      tierId = cached;
    } else {
      specId = specCache.get(specialisationName.toLowerCase()) ?? null;
      if (specId === null) {
        let spec = await prisma.specialisation.findFirst({ where: { name: specialisationName } });
        if (!spec) {
          spec = await prisma.specialisation.create({ data: { name: specialisationName } });
        }
        specId = spec.id;
        specCache.set(specialisationName.toLowerCase(), specId);
      }
    }

    // --- Create ProgramData record with alternatives ---
    await prisma.programData.create({
      data: {
        programName,
        specialisationId: specId,
        tierId,
        purpose: hasTier ? "deployment" : purpose,
        level: level as "Country" | "Theatre" | "Global",
        trainingType: resolvedTrainingType as "Certification" | "Accreditation" | "InstructorLedTraining" | null,
        trainingTitle: resolvedTrainingTitle,
        quantityRequired,
        minimumPerTheatre,
        alternatives: altData.length > 0 ? {
          create: altData.map((a) => ({
            trainingType: a.trainingType as "Certification" | "Accreditation" | "InstructorLedTraining",
            trainingTitle: a.trainingTitle,
          })),
        } : undefined,
      },
    });
    created++;
  }

  if (dryRun) {
    // In dry-run mode, "created" = number of rows that would succeed
    const wouldCreate = rows.length - skipped;
    return NextResponse.json({ created: wouldCreate, skipped, errors });
  }

  return NextResponse.json({ created, skipped, errors });
}
