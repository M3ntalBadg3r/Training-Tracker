import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import {
  IMPORT_TARGET_FIELDS,
  IMPORT_TARGET_FIELD_KEYS,
  isImportTargetFieldKey,
  type ImportTargetFieldKey,
} from "@/lib/import-target-fields";

// Resolve a Target Field cell value to a known key. The export writes the
// human label ("Email Address"); we also accept the key ("email") so a file
// the user has hand-edited still imports cleanly. Match is case-insensitive
// and ignores punctuation, mirroring the wizard's own norm() helper.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const LABEL_TO_KEY = new Map<string, ImportTargetFieldKey>(
  IMPORT_TARGET_FIELDS.map((f) => [norm(f.label), f.key])
);
const KEY_LOOKUP = new Set<string>(IMPORT_TARGET_FIELD_KEYS.map(norm));

function resolveTargetField(raw: string): ImportTargetFieldKey | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isImportTargetFieldKey(trimmed)) return trimmed;
  const normalised = norm(trimmed);
  const fromLabel = LABEL_TO_KEY.get(normalised);
  if (fromLabel) return fromLabel;
  if (KEY_LOOKUP.has(normalised)) {
    return IMPORT_TARGET_FIELD_KEYS.find((k) => norm(k) === normalised) ?? null;
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json().catch(() => ({}));
  const { rows, columnMapping } = body as {
    rows?: Record<string, string>[];
    columnMapping?: { targetField?: string; alias?: string };
  };

  if (!Array.isArray(rows) || !columnMapping?.targetField || !columnMapping?.alias) {
    return NextResponse.json(
      { error: "Missing rows or column mapping" },
      { status: 400 }
    );
  }
  if (rows.length > 10_000) {
    return NextResponse.json(
      { error: "Too many rows in a single import (max 10,000)." },
      { status: 413 }
    );
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const rawField = row[columnMapping.targetField]?.toString() ?? "";
    const rawAlias = row[columnMapping.alias]?.toString() ?? "";

    const targetField = resolveTargetField(rawField);
    const alias = rawAlias.trim();

    if (!targetField) {
      errors.push(`Row ${rowNum}: Unknown target field "${rawField.trim()}"`);
      skipped++;
      continue;
    }
    if (!alias) {
      errors.push(`Row ${rowNum}: Missing alias value`);
      skipped++;
      continue;
    }

    const key = `${targetField}::${alias}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);

    try {
      const existing = await prisma.importAlias.findFirst({
        where: { targetField, alias },
      });
      if (existing) {
        skipped++;
        continue;
      }
      await prisma.importAlias.create({ data: { targetField, alias } });
      imported++;
    } catch (err) {
      console.error(`Import alias row ${rowNum} error:`, err);
      errors.push(`Row ${rowNum}: Failed to import "${alias}"`);
      skipped++;
    }
  }

  await prisma.importMetadata.upsert({
    where: { key: "import-aliases" },
    update: { timestamp: new Date() },
    create: { key: "import-aliases", timestamp: new Date() },
  });

  return NextResponse.json({ imported, skipped, errors });
}
