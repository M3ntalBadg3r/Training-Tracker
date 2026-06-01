import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const { rows, columnMapping } = body as {
    rows: Record<string, string>[];
    columnMapping: { name: string };
  };

  if (!rows || !columnMapping?.name) {
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
  const updated = 0; // product types only carry a name, so there is nothing to update
  const errors: string[] = [];

  // Track names already processed in this batch (case-insensitive) so a file
  // with duplicate rows doesn't attempt to create the same type twice.
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row[columnMapping.name]?.trim();
    const rowNum = i + 2; // +2 because row 1 is header, data starts at row 2

    if (!name) {
      errors.push(`Row ${rowNum}: Missing name value`);
      skipped++;
      continue;
    }

    if (seen.has(name.toLowerCase())) {
      skipped++;
      continue;
    }
    seen.add(name.toLowerCase());

    try {
      const existing = await prisma.productType.findFirst({
        where: { name: { equals: name, mode: "insensitive" } },
      });

      if (existing) {
        skipped++;
      } else {
        await prisma.productType.create({ data: { name } });
        imported++;
      }
    } catch (err) {
      console.error(`Product type import row ${rowNum} error:`, err);
      const safeMessage = err instanceof Error && err.message.includes("Unique constraint")
        ? "Duplicate entry"
        : "Failed to process";
      errors.push(`Row ${rowNum}: Failed to import "${name}" - ${safeMessage}`);
      skipped++;
    }
  }

  // Record last import timestamp for product types
  await prisma.importMetadata.upsert({
    where: { key: "product-types" },
    update: { timestamp: new Date() },
    create: { key: "product-types", timestamp: new Date() },
  });

  return NextResponse.json({ imported, updated, skipped, errors });
}
