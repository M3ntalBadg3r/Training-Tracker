import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { TrainingType, ProductType, FunctionType } from "@prisma/client";
import { requireAuth, handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { recomputeAllStudentsForParent } from "@/lib/olx";

const VALID_TRAINING_TYPES = new Set(Object.values(TrainingType));
const VALID_PRODUCT_TYPES = new Set(Object.values(ProductType));
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

const PRODUCT_TYPE_MAP: Record<string, ProductType> = {
  cortex: ProductType.Cortex,
  sase: ProductType.SASE,
  cloud: ProductType.Cloud,
  strata: ProductType.Strata,
  foundation: ProductType.Foundation,
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

function parseProductType(val: string | undefined): ProductType | null {
  if (!val) return null;
  const trimmed = val.trim();
  if (VALID_PRODUCT_TYPES.has(trimmed as ProductType)) return trimmed as ProductType;
  return PRODUCT_TYPE_MAP[trimmed.toLowerCase()] ?? null;
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

  // Parse default values
  const defaultTrainingType = parseTrainingType(defaults?.trainingType) ?? TrainingType.Certification;
  const defaultProductType = parseProductType(defaults?.productType) ?? ProductType.Cortex;
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
    const productType = parseProductType(rawProductType) ?? defaultProductType;
    const functionType = parseFunctionType(rawFunction) ?? defaultFunctionType;

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

    try {
      const existing = await prisma.trainingData.findUnique({
        where: { trainingTitle },
      });

      if (existing) {
        const changed =
          existing.fullTitle !== fullTitle ||
          existing.trainingType !== trainingType ||
          existing.productType !== productType ||
          existing.function !== functionType ||
          existing.link !== link ||
          JSON.stringify(existing.certification) !== JSON.stringify(certification);

        if (changed) {
          await prisma.trainingData.update({
            where: { trainingTitle },
            data: { fullTitle, trainingType, productType, function: functionType, link, certification },
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
            productType,
            function: functionType,
            link,
            certification,
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

  return NextResponse.json({ imported, updated, skipped, errors });
}
