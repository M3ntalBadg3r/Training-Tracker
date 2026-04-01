import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

interface RawRow {
  programName?: string;
  specialisationName?: string;
  level?: string;
  trainingType?: string;
  trainingFullTitle?: string;
  quantityRequired?: string | number;
  minimumPerTheatre?: string | number | null;
}

const LEVEL_MAP: Record<string, string> = {
  country: "Country",
  theatre: "Theatre",
  global: "Global",
};

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
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const body = await request.json();
  const rows: RawRow[] = body.rows ?? [];

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "No rows provided" }, { status: 400 });
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

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 1;
    const raw = rows[i];

    // --- Required field presence ---
    const programName = raw.programName?.trim() ?? "";
    const specialisationName = raw.specialisationName?.trim() ?? "";
    const rawLevel = raw.level?.trim() ?? "";
    const rawTrainingType = raw.trainingType?.trim() ?? "";
    const rawTrainingFullTitle = raw.trainingFullTitle?.trim() ?? "";
    const rawQty = raw.quantityRequired;
    const rawMinPerTheatre = raw.minimumPerTheatre;

    if (!programName) {
      errors.push({ row: rowNum, message: "Program Name is required" });
      skipped++;
      continue;
    }
    if (!specialisationName) {
      errors.push({ row: rowNum, message: "Specialisation is required" });
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
    if (rawMinPerTheatre !== null && rawMinPerTheatre !== undefined && String(rawMinPerTheatre).trim() !== "") {
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
    } else if (level !== "Global") {
      // Non-global rows must have training
      errors.push({ row: rowNum, message: "Training Type and Training are required for Country and Theatre level rows" });
      skipped++;
      continue;
    }
    // Global + no training = APS-style "count compliant theatres" mode (allowed)

    if (dryRun) {
      // Validation passed — don't write
      continue;
    }

    // --- Resolve/create specialisation ---
    let specId = specCache.get(specialisationName.toLowerCase());
    if (specId === undefined) {
      let spec = await prisma.specialisation.findFirst({ where: { name: specialisationName } });
      if (!spec) {
        spec = await prisma.specialisation.create({ data: { name: specialisationName } });
      }
      specId = spec.id;
      specCache.set(specialisationName.toLowerCase(), specId!);
    }

    // --- Create ProgramData record ---
    await prisma.programData.create({
      data: {
        programName,
        specialisationId: specId,
        level: level as "Country" | "Theatre" | "Global",
        trainingType: resolvedTrainingType as "Certification" | "Accreditation" | "InstructorLedTraining" | null,
        trainingTitle: resolvedTrainingTitle,
        quantityRequired,
        minimumPerTheatre,
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
