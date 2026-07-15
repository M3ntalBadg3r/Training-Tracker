import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { TrainingType, FunctionType } from "@prisma/client";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { recomputeAllStudentsForParent } from "@/lib/olx";
import { invalidateReportCache } from "@/lib/report-cache";

const VALID_TRAINING_TYPES = new Set(Object.values(TrainingType));
const VALID_FUNCTION_TYPES = new Set(Object.values(FunctionType));

// Maps for human-readable labels → enum values
const TRAINING_TYPE_MAP: Record<string, TrainingType> = {
  certification: TrainingType.Certification,
  certs: TrainingType.Certification,
  cert: TrainingType.Certification,
  accreditation: TrainingType.Accreditation,
  accreditations: TrainingType.Accreditation,
  "instructor-led training": TrainingType.InstructorLedTraining,
  instructorledtraining: TrainingType.InstructorLedTraining,
  ilt: TrainingType.InstructorLedTraining,
  olx: TrainingType.OLX,
  online: TrainingType.OLX,
  "olx sub-item": TrainingType.OLXSubItem,
  "olx subitem": TrainingType.OLXSubItem,
  olxsubitem: TrainingType.OLXSubItem,
};

const FUNCTION_TYPE_MAP: Record<string, FunctionType> = {
  sales: FunctionType.Sales,
  "pre-sales": FunctionType.PreSales,
  presales: FunctionType.PreSales,
  deployments: FunctionType.Deployments,
  deployment: FunctionType.Deployments,
};

function parseTrainingType(val: string | undefined): TrainingType | null {
  if (!val) return null;
  const trimmed = val.trim();
  if (VALID_TRAINING_TYPES.has(trimmed as TrainingType)) return trimmed as TrainingType;
  return TRAINING_TYPE_MAP[trimmed.toLowerCase()] ?? null;
}

function parseFunctionType(val: string | undefined): FunctionType | null {
  if (!val) return null;
  const trimmed = val.trim();
  if (VALID_FUNCTION_TYPES.has(trimmed as FunctionType)) return trimmed as FunctionType;
  return FUNCTION_TYPE_MAP[trimmed.toLowerCase()] ?? null;
}

interface ColumnMapping {
  trainingTitle: string;
  fullTitle: string;
  trainingType?: string;
  productType?: string;
  function?: string;
  link?: string;
  certification?: string;
  parentTrainingTitle?: string;
  legacy?: string;
  replacement?: string;
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const body = await request.json();
  const { rows, columnMapping, defaults } = body as {
    rows: Record<string, string>[];
    columnMapping: ColumnMapping;
    defaults?: {
      trainingType?: string;
      productType?: string;
      function?: string;
    };
  };

  if (Array.isArray(rows) && rows.length > 25_000) {
    return NextResponse.json(
      { error: "Too many rows in a single import (max 25,000)." },
      { status: 413 }
    );
  }
  if (!rows || !columnMapping?.trainingTitle || !columnMapping?.fullTitle) {
    return NextResponse.json(
      { error: "Missing rows or required column mapping (trainingTitle, fullTitle)" },
      { status: 400 }
    );
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Track parents whose membership set changed so we can recompute student
  // OLX completion at the end. Also remember any parent links that referenced
  // a parent that doesn't yet exist after this batch.
  const parentLinks: { subItem: string; parent: string }[] = [];
  const affectedParents = new Set<string>();

  // Product types are an admin-managed table; load them once and resolve names
  // (case-insensitive) to ids. Unknown values are reported per-row rather than
  // silently coerced.
  const productTypeRows = await prisma.productType.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const productTypeByName = new Map<string, number>(
    productTypeRows.map((pt: { id: number; name: string }) => [pt.name.toLowerCase(), pt.id])
  );
  const parseProductTypeId = (val: string | undefined): number | null => {
    if (!val) return null;
    return productTypeByName.get(val.trim().toLowerCase()) ?? null;
  };

  // Parse default values
  const defaultTrainingType = parseTrainingType(defaults?.trainingType) ?? TrainingType.Certification;
  // Default product type: the import-level default if resolvable, else the
  // alphabetically-first configured product type. May be null if none exist.
  const defaultProductTypeId =
    parseProductTypeId(defaults?.productType) ?? productTypeRows[0]?.id ?? null;
  const defaultFunctionType = parseFunctionType(defaults?.function) ?? FunctionType.Sales;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    const trainingTitle = row[columnMapping.trainingTitle]?.trim();
    const fullTitle = row[columnMapping.fullTitle]?.trim();

    if (!trainingTitle) {
      errors.push(`Row ${rowNum}: Missing Training Title`);
      skipped++;
      continue;
    }
    if (!fullTitle) {
      errors.push(`Row ${rowNum}: Missing Full Title for "${trainingTitle}"`);
      skipped++;
      continue;
    }

    // Resolve enum fields: use mapped column if present, fall back to defaults
    const rawTrainingType = columnMapping.trainingType ? row[columnMapping.trainingType]?.trim() : undefined;
    const rawProductType = columnMapping.productType ? row[columnMapping.productType]?.trim() : undefined;
    const rawFunction = columnMapping.function ? row[columnMapping.function]?.trim() : undefined;

    let trainingType = parseTrainingType(rawTrainingType) ?? defaultTrainingType;
    const functionType = parseFunctionType(rawFunction) ?? defaultFunctionType;

    // Resolve product type: an explicit (but unknown) cell is an error; an
    // empty cell falls back to the default. No default at all is an error.
    let productTypeId: number;
    if (rawProductType) {
      const resolved = parseProductTypeId(rawProductType);
      if (resolved === null) {
        errors.push(`Row ${rowNum}: Unknown product type "${rawProductType}" for "${trainingTitle}"`);
        skipped++;
        continue;
      }
      productTypeId = resolved;
    } else if (defaultProductTypeId !== null) {
      productTypeId = defaultProductTypeId;
    } else {
      errors.push(`Row ${rowNum}: No product type for "${trainingTitle}" and no product types are configured`);
      skipped++;
      continue;
    }

    // OLX sub-item parents: comma-separated list. Presence forces type to OLXSubItem.
    const rawParents = columnMapping.parentTrainingTitle
      ? row[columnMapping.parentTrainingTitle]?.trim()
      : "";
    const parentsList = rawParents
      ? Array.from(new Set(rawParents.split(",").map((p: string) => p.trim()).filter(Boolean)))
      : [];
    if (parentsList.length > 0) {
      trainingType = TrainingType.OLXSubItem;
    }

    const link = columnMapping.link ? row[columnMapping.link]?.trim() || null : null;
    const certRaw = columnMapping.certification ? row[columnMapping.certification]?.trim() : "";
    const certification = trainingType === TrainingType.OLXSubItem
      ? []
      : certRaw
        ? certRaw.split(",").map((c: string) => c.trim()).filter(Boolean)
        : [];

    // Legacy lifecycle — only meaningful for Certification/Accreditation.
    const legacyEligible = trainingType === TrainingType.Certification || trainingType === TrainingType.Accreditation;
    const legacyRaw = columnMapping.legacy ? row[columnMapping.legacy]?.trim() : "";
    const isLegacy = legacyEligible && /^(true|yes|y|1|legacy)$/i.test(legacyRaw || "");
    const replacementRaw = columnMapping.replacement ? row[columnMapping.replacement]?.trim() : "";
    const replacedBy = isLegacy && replacementRaw
      ? Array.from(new Set(replacementRaw.split(",").map((c: string) => c.trim()).filter((c) => Boolean(c) && c !== trainingTitle)))
      : [];

    try {
      const existing = await prisma.trainingData.findUnique({
        where: { trainingTitle },
      });

      if (existing) {
        const changed =
          existing.fullTitle !== fullTitle ||
          existing.trainingType !== trainingType ||
          existing.productTypeId !== productTypeId ||
          existing.function !== functionType ||
          existing.link !== link ||
          JSON.stringify(existing.certification) !== JSON.stringify(certification) ||
          existing.isLegacy !== isLegacy ||
          JSON.stringify(existing.replacedBy) !== JSON.stringify(replacedBy);

        if (changed) {
          await prisma.trainingData.update({
            where: { trainingTitle },
            data: { fullTitle, trainingType, productTypeId, function: functionType, link, certification, isLegacy, replacedBy },
          });
          updated++;
        } else {
          skipped++;
        }
      } else {
        await prisma.trainingData.create({
          data: {
            trainingTitle,
            fullTitle,
            trainingType,
            productTypeId,
            function: functionType,
            link,
            certification,
            isLegacy,
            replacedBy,
          },
        });
        imported++;
      }

      // Queue parent ↔ sub-item links for processing once all rows have
      // been upserted (parents may appear later in the file).
      for (const parent of parentsList) {
        parentLinks.push({ subItem: trainingTitle, parent });
      }
    } catch (err) {
      console.error(`Training data import row ${rowNum} error:`, err);
      const safeMessage = err instanceof Error && err.message.includes("Unique constraint")
        ? "Duplicate entry"
        : "Failed to process";
      errors.push(
        `Row ${rowNum}: Failed to import "${trainingTitle}" - ${safeMessage}`
      );
      skipped++;
    }
  }

  // Apply parent ↔ sub-item links after all rows have been processed, so that
  // a parent OLX referenced by an earlier sub-item row but defined later in
  // the file still resolves correctly. Skip links whose parent is missing or
  // not actually an OLX entry, with a warning.
  if (parentLinks.length > 0) {
    const parentTitles = Array.from(new Set(parentLinks.map((l) => l.parent)));
    const parentRows = await prisma.trainingData.findMany({
      where: { trainingTitle: { in: parentTitles } },
      select: { trainingTitle: true, trainingType: true },
    });
    const parentTypeByTitle = new Map(parentRows.map((p) => [p.trainingTitle, p.trainingType]));

    for (const { subItem, parent } of parentLinks) {
      const parentType = parentTypeByTitle.get(parent);
      if (parentType === undefined) {
        errors.push(`Parent OLX "${parent}" referenced by sub-item "${subItem}" was not found.`);
        continue;
      }
      if (parentType !== TrainingType.OLX) {
        errors.push(`Parent "${parent}" referenced by sub-item "${subItem}" is not an OLX (it's ${parentType}).`);
        continue;
      }
      await prisma.olxSubItemRelation.upsert({
        where: {
          parentTrainingTitle_subItemTrainingTitle: {
            parentTrainingTitle: parent,
            subItemTrainingTitle: subItem,
          },
        },
        update: {},
        create: { parentTrainingTitle: parent, subItemTrainingTitle: subItem },
      });
      affectedParents.add(parent);
    }
  }

  // Recompute parent OLX completion for any membership changes.
  for (const p of affectedParents) {
    try {
      await recomputeAllStudentsForParent(p);
    } catch (error) {
      console.error(`Failed to recompute parent "${p}":`, error);
      errors.push(`Recomputation failed for parent OLX "${p}".`);
    }
  }

  // Record last import timestamp for training data
  await prisma.importMetadata.upsert({
    where: { key: "training-data" },
    update: { timestamp: new Date() },
    create: { key: "training-data", timestamp: new Date() },
  });

  invalidateReportCache();
  return NextResponse.json({ imported, updated, skipped, errors });
}
