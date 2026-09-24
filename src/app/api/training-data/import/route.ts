import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { TrainingType, FunctionType } from "@prisma/client";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { recomputeAllStudentsForParent } from "@/lib/olx";
import { invalidateReportCache } from "@/lib/report-cache";
import { readJsonBody } from "@/lib/request-body";
import { isRejectedLink, safeExternalUrl } from "@/lib/utils";
import { sanitizeLegacyFields } from "@/lib/legacy-training";

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
  ignored?: string;
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
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
  // Of `updated`, how many were entries awaiting review that this file
  // classified — i.e. how many left the "needs attention" list. A subset of
  // `updated`, not an additional count.
  let completed = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Track parents whose membership set changed so we can recompute student
  // OLX completion at the end. Also remember any parent links that referenced
  // a parent that doesn't yet exist after this batch.
  const parentLinks: { subItem: string; parent: string }[] = [];
  // Replacement lists from the file, resolved after every row is written —
  // same reason as `parentLinks`: a replacement defined further down the file
  // does not exist yet while its legacy row is being processed. `outcome` is
  // how the row was already counted, so a row whose only change turns out to
  // be its replacement moves from skipped to updated rather than counting twice.
  const pendingReplacements: {
    trainingTitle: string;
    rowNum: number;
    replacedBy: string[];
    outcome: "created" | "updated" | "skipped";
  }[] = [];
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

    // The stored row is read up front because the classification columns
    // below resolve against it: a mapped-but-blank cell keeps what is stored.
    let existing: Awaited<ReturnType<typeof prisma.trainingData.findUnique>>;
    try {
      existing = await prisma.trainingData.findUnique({ where: { trainingTitle } });
    } catch (err) {
      console.error(`Training data import row ${rowNum} lookup error:`, err);
      errors.push(`Row ${rowNum}: Failed to import "${trainingTitle}" - Failed to process`);
      skipped++;
      continue;
    }

    // Resolve enum fields: use mapped column if present, fall back to defaults.
    //
    // A column that is MAPPED but blank on this row is not the same as an
    // unmapped one. The wizard's defaults are offered only for unmapped
    // columns; a blank cell is the file saying "not set" — which is exactly
    // what the export writes for an entry still awaiting review, since its
    // stored Type/Product/Function are import placeholders nobody chose. So a
    // blank cell leaves an existing row's value alone (it used to overwrite a
    // curated classification with the defaults), and a new row created from
    // one is flagged as needing attention rather than silently classified.
    const rawTrainingType = columnMapping.trainingType ? row[columnMapping.trainingType]?.trim() : undefined;
    const rawProductType = columnMapping.productType ? row[columnMapping.productType]?.trim() : undefined;
    const rawFunction = columnMapping.function ? row[columnMapping.function]?.trim() : undefined;
    const blankTrainingType = Boolean(columnMapping.trainingType) && !rawTrainingType;
    const blankProductType = Boolean(columnMapping.productType) && !rawProductType;
    const blankFunction = Boolean(columnMapping.function) && !rawFunction;

    const cellTrainingType = parseTrainingType(rawTrainingType);
    const cellFunctionType = parseFunctionType(rawFunction);

    let trainingType =
      cellTrainingType ?? (blankTrainingType && existing ? existing.trainingType : defaultTrainingType);
    const functionType =
      cellFunctionType ?? (blankFunction && existing ? existing.function : defaultFunctionType);

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
    } else if (blankProductType && existing) {
      productTypeId = existing.productTypeId;
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

    // Whether THIS ROW'S OWN CELLS classify the training — Type (or a parent,
    // which forces it), Product and Function all supplied. This is what may
    // complete an entry still awaiting review (`isIncomplete`), mirroring the
    // interactive completion path, which requires all three to be chosen.
    // Import-level defaults deliberately do not count: they are pre-filled
    // with the very placeholder values an auto-created row already carries,
    // so accepting them would mark it reviewed with values nobody picked.
    const classifiedByRow =
      (parentsList.length > 0 || cellTrainingType !== null) &&
      Boolean(rawProductType) &&
      cellFunctionType !== null;
    // A new row whose file leaves any classification cell blank is created
    // with placeholders, so it is flagged exactly like a student-import
    // auto-create — never counted under a category nobody chose.
    const leftUnclassified =
      (blankTrainingType && parentsList.length === 0) || blankProductType || blankFunction;

    // A spreadsheet is the cheapest way to plant links in bulk, so the same
    // scheme allowlist the interactive routes enforce applies here. The row is
    // still imported — dropping one bad link is better than failing an
    // otherwise-good catalogue import — but the Admin is told which and why.
    const rawLink = columnMapping.link ? row[columnMapping.link]?.trim() || null : null;
    if (isRejectedLink(rawLink)) {
      errors.push(`Row ${rowNum}: link for "${trainingTitle}" is not a http:// or https:// web address and was not imported`);
    }
    const link = safeExternalUrl(rawLink);
    // "Leads to certification", under the same unmapped-column-is-a-no-op rule
    // as the legacy pair below. It did NOT have that rule, and the update always
    // writes the column, so importing a file that simply didn't carry a
    // Certification column silently cleared "leads to" on every row it touched.
    // That is the exact data loss the Legacy column was fixed for; this one was
    // missed, and it is worse here because nothing surfaces the absence — the
    // training just quietly stops leading anywhere and its learners drop out of
    // the Trained But Not Certified report.
    const certRaw = columnMapping.certification ? row[columnMapping.certification]?.trim() : undefined;
    const parsedCertification = columnMapping.certification
      ? (certRaw || "").split(",").map((c: string) => c.trim()).filter(Boolean)
      : undefined;

    /**
     * Resolve "leads to" against what is already stored, so an absent column
     * reproduces the existing value and the `changed` comparison sees a no-op.
     */
    const resolveCertification = (stored: { certification: string[] } | null): string[] => {
      // An OLX sub-item may never carry a certification, matching every other
      // write path — that is the type forcing it, not the import clobbering it.
      if (trainingType === TrainingType.OLXSubItem) return [];
      return parsedCertification ?? stored?.certification ?? [];
    };

    // Legacy lifecycle — only meaningful for Certification/Accreditation.
    //
    // An UNMAPPED column must not write anything. These used to resolve to
    // `false` / `[]` whenever their column was absent, and the update below
    // always writes them, so importing a file that simply didn't carry a Legacy
    // column silently cleared the legacy marker on every row it touched — data
    // loss from an import that looked like it only changed the columns present.
    // Resolving against the stored row instead makes an absent column a no-op,
    // and leaves an explicit column the only thing that can change the value.
    const legacyEligible = trainingType === TrainingType.Certification || trainingType === TrainingType.Accreditation;
    const legacyRaw = columnMapping.legacy ? row[columnMapping.legacy]?.trim() : undefined;
    const parsedIsLegacy = columnMapping.legacy
      ? /^(true|yes|y|1|legacy)$/i.test(legacyRaw || "")
      : undefined;
    const replacementRaw = columnMapping.replacement ? row[columnMapping.replacement]?.trim() : undefined;
    const parsedReplacedBy = columnMapping.replacement
      ? Array.from(new Set((replacementRaw || "").split(",").map((c: string) => c.trim()).filter((c) => Boolean(c) && c !== trainingTitle)))
      : undefined;

    // A mapped Replacement column on a row that ends up legacy is resolved
    // after the loop (see `pendingReplacements`), not here: the sanitiser keeps
    // only titles that exist as a Cert/Accred right now, so resolving it
    // row-by-row silently dropped every replacement that appears later in the
    // file, and a catalogue needed importing twice to come out whole. Until
    // then the row keeps its stored list, so this pass sees no change there.
    // An UNMAPPED column is unaffected and still resolves against the stored
    // value below — deferring it would be pointless, and it must stay a no-op.
    const deferReplacement =
      legacyEligible &&
      parsedReplacedBy !== undefined &&
      (parsedIsLegacy ?? existing?.isLegacy ?? false);

    /**
     * Resolve the legacy pair against what is already stored. Writing the
     * result unconditionally is safe: with both columns unmapped it reproduces
     * the existing values, so the `changed` comparison sees a no-op.
     */
    const resolveLegacy = async (
      stored: { isLegacy: boolean; replacedBy: string[] } | null,
    ): Promise<{ isLegacy: boolean; replacedBy: string[] }> => {
      // A type that cannot be legacy clears the pair regardless of the file —
      // that is the type change forcing it, not the import clobbering it.
      if (!legacyEligible) return { isLegacy: false, replacedBy: [] };
      const effective = parsedIsLegacy ?? stored?.isLegacy ?? false;
      // Replacements only mean anything on a legacy row.
      if (!effective) return { isLegacy: false, replacedBy: [] };
      if (deferReplacement) return { isLegacy: true, replacedBy: stored?.replacedBy ?? [] };
      // Through the same sanitiser every interactive write path uses. The import
      // was the one route that wrote `replacedBy` straight from the file, so a
      // misspelled or non-Cert/Accred title — easy to produce, since the export
      // emits internal training titles and a spreadsheet edit invites pasting
      // the displayed Full Title instead — was persisted as a dangling
      // reference that renders as a raw key and matches no holders.
      return sanitizeLegacyFields(
        trainingTitle,
        trainingType,
        true,
        parsedReplacedBy ?? stored?.replacedBy ?? [],
      );
    };

    // Same rule for the "not needed" flag.
    const ignoredRaw = columnMapping.ignored ? row[columnMapping.ignored]?.trim() : undefined;
    const isIgnored = columnMapping.ignored
      ? /^(true|yes|y|1|ignored|ignore)$/i.test(ignoredRaw || "")
      : undefined;

    try {
      if (existing) {
        const legacy = await resolveLegacy(existing);
        const certification = resolveCertification(existing);
        // An entry awaiting review is completed by a row that classifies it.
        // Without this an exported-then-imported catalogue left every such
        // entry in "needs attention" however fully the file described it.
        const completes = existing.isIncomplete && classifiedByRow;
        const changed =
          completes ||
          existing.fullTitle !== fullTitle ||
          existing.trainingType !== trainingType ||
          existing.productTypeId !== productTypeId ||
          existing.function !== functionType ||
          existing.link !== link ||
          JSON.stringify(existing.certification) !== JSON.stringify(certification) ||
          existing.isLegacy !== legacy.isLegacy ||
          JSON.stringify(existing.replacedBy) !== JSON.stringify(legacy.replacedBy) ||
          (isIgnored !== undefined && existing.isIgnored !== isIgnored);

        if (changed) {
          await prisma.trainingData.update({
            where: { trainingTitle },
            data: {
              fullTitle, trainingType, productTypeId, function: functionType, link, certification,
              isLegacy: legacy.isLegacy, replacedBy: legacy.replacedBy,
              ...(isIgnored !== undefined && { isIgnored }),
              ...(completes && { isIncomplete: false }),
            },
          });
          updated++;
          if (completes) completed++;
        } else {
          skipped++;
        }
        if (deferReplacement && parsedReplacedBy) {
          pendingReplacements.push({
            trainingTitle, rowNum, replacedBy: parsedReplacedBy, outcome: changed ? "updated" : "skipped",
          });
        }
      } else {
        const legacy = await resolveLegacy(null);
        const certification = resolveCertification(null);
        await prisma.trainingData.create({
          data: {
            trainingTitle,
            fullTitle,
            trainingType,
            productTypeId,
            function: functionType,
            link,
            certification,
            isLegacy: legacy.isLegacy,
            replacedBy: legacy.replacedBy,
            ...(isIgnored !== undefined && { isIgnored }),
            ...(leftUnclassified && { isIncomplete: true }),
          },
        });
        imported++;
        if (deferReplacement && parsedReplacedBy) {
          pendingReplacements.push({ trainingTitle, rowNum, replacedBy: parsedReplacedBy, outcome: "created" });
        }
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

  // Resolve deferred replacement lists now that every row in the file exists.
  // The row's CURRENT type and legacy flag are re-read rather than carried
  // over, so a later row for the same title that changed either one wins, as
  // it would for any other column. A replacement that still does not resolve
  // names nothing in the catalogue; it used to be dropped without a word, which
  // was unavoidable while it might merely not have been written yet.
  for (const p of pendingReplacements) {
    try {
      const current = await prisma.trainingData.findUnique({
        where: { trainingTitle: p.trainingTitle },
        select: { trainingType: true, isLegacy: true, replacedBy: true },
      });
      if (!current) continue;
      const resolved = await sanitizeLegacyFields(p.trainingTitle, current.trainingType, current.isLegacy, p.replacedBy);
      if (resolved.isLegacy) {
        const dropped = p.replacedBy.filter((t) => !resolved.replacedBy.includes(t));
        if (dropped.length > 0) {
          errors.push(
            `Row ${p.rowNum}: replacement ${dropped.map((t) => `"${t}"`).join(", ")} for "${p.trainingTitle}" was not saved — no Certification or Accreditation has that Training Title`
          );
        }
      }
      if (JSON.stringify(current.replacedBy) !== JSON.stringify(resolved.replacedBy)) {
        await prisma.trainingData.update({
          where: { trainingTitle: p.trainingTitle },
          data: { replacedBy: resolved.replacedBy },
        });
        if (p.outcome === "skipped") {
          skipped--;
          updated++;
        }
      }
    } catch (err) {
      console.error(`Training data import row ${p.rowNum} replacement error:`, err);
      errors.push(`Row ${p.rowNum}: Failed to save the replacement for "${p.trainingTitle}" - Failed to process`);
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
  return NextResponse.json({ imported, updated, completed, skipped, errors });
}
