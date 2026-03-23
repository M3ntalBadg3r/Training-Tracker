import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { TrainingType, ProductType, FunctionType } from "@prisma/client";

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
}

export async function POST(request: NextRequest) {
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

    const trainingType = parseTrainingType(rawTrainingType) ?? defaultTrainingType;
    const productType = parseProductType(rawProductType) ?? defaultProductType;
    const functionType = parseFunctionType(rawFunction) ?? defaultFunctionType;

    const link = columnMapping.link ? row[columnMapping.link]?.trim() || null : null;

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
          existing.link !== link;

        if (changed) {
          await prisma.trainingData.update({
            where: { trainingTitle },
            data: { fullTitle, trainingType, productType, function: functionType, link },
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
          },
        });
        imported++;
      }
    } catch (err) {
      errors.push(
        `Row ${rowNum}: Failed to import "${trainingTitle}" - ${err instanceof Error ? err.message : String(err)}`
      );
      skipped++;
    }
  }

  return NextResponse.json({ imported, updated, skipped, errors });
}
