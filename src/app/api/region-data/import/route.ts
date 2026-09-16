import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { readJsonBody } from "@/lib/request-body";
import { normaliseIsoCode } from "@/lib/iso-countries";

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const { rows, columnMapping } = body as {
    rows: Record<string, string>[];
    columnMapping: {
      country: string;
      region: string;
      theatre?: string;
      isoCode?: string;
    };
  };

  if (!rows || !columnMapping?.country || !columnMapping?.region) {
    return NextResponse.json(
      { error: "Missing rows or column mapping" },
      { status: 400 }
    );
  }
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: "rows must be an array" }, { status: 400 });
  }
  if (rows.length > 10_000) {
    return NextResponse.json(
      { error: "Too many rows in a single import (max 10,000)." },
      { status: 413 }
    );
  }

  let imported = 0;
  let skipped = 0;
  let updated = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const country = row[columnMapping.country]?.trim();
    const region = row[columnMapping.region]?.trim();
    const theatreRaw = columnMapping.theatre ? row[columnMapping.theatre]?.trim() : "";
    const theatre = theatreRaw ? theatreRaw : null;
    // An unmapped column must write NOTHING. When columnMapping.isoCode is
    // absent we neither compare nor write it, so a file with no ISO column
    // leaves every stored code alone — the same rule theatre follows above.
    // (The training-data Legacy/Replacement columns are the documented example
    // of what happens when this is got wrong: importing a file without the
    // column silently cleared the value on every row it touched.)
    const isoRaw = columnMapping.isoCode ? row[columnMapping.isoCode] : undefined;
    const isoCode = columnMapping.isoCode ? normaliseIsoCode(isoRaw ?? null) : undefined;
    const rowNum = i + 2; // +2 because row 1 is header, data starts at row 2

    if (!country) {
      errors.push(`Row ${rowNum}: Missing country value`);
      skipped++;
      continue;
    }
    if (!region) {
      errors.push(`Row ${rowNum}: Missing region value for country "${country}"`);
      skipped++;
      continue;
    }
    // A mapped-but-malformed ISO cell skips the row rather than being dropped
    // silently — the operator asked for that column to be applied.
    if (columnMapping.isoCode && isoCode === undefined) {
      errors.push(
        `Row ${rowNum}: ISO code for "${country}" must be two letters (ISO 3166-1 alpha-2)`
      );
      skipped++;
      continue;
    }

    try {
      const existing = await prisma.regionData.findUnique({
        where: { country },
      });

      if (existing) {
        // Only mark "updated" when something actually changes. When the
        // import has no theatre column, leave the existing theatre alone.
        const regionChanged = existing.region !== region;
        const theatreChanged = columnMapping.theatre
          ? (existing.theatre ?? null) !== theatre
          : false;
        const isoChanged = columnMapping.isoCode
          ? (existing.isoCode ?? null) !== (isoCode ?? null)
          : false;
        if (regionChanged || theatreChanged || isoChanged) {
          await prisma.regionData.update({
            where: { country },
            data: {
              region,
              ...(columnMapping.theatre ? { theatre } : {}),
              ...(columnMapping.isoCode ? { isoCode: isoCode ?? null } : {}),
            },
          });
          updated++;
        } else {
          skipped++;
        }
      } else {
        await prisma.regionData.create({
          data: { country, region, theatre, isoCode: isoCode ?? null },
        });
        imported++;
      }
    } catch (err) {
      console.error(`Region data import row ${rowNum} error:`, err);
      const safeMessage = err instanceof Error && err.message.includes("Unique constraint")
        ? "Duplicate entry"
        : "Failed to process";
      errors.push(
        `Row ${rowNum}: Failed to import "${country}" - ${safeMessage}`
      );
      skipped++;
    }
  }

  // Record last import timestamp for region data
  await prisma.importMetadata.upsert({
    where: { key: "region-data" },
    update: { timestamp: new Date() },
    create: { key: "region-data", timestamp: new Date() },
  });

  return NextResponse.json({ imported, updated, skipped, errors });
}
