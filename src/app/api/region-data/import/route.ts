import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const body = await request.json();
  const { rows, columnMapping } = body as {
    rows: Record<string, string>[];
    columnMapping: { country: string; region: string };
  };

  if (!rows || !columnMapping?.country || !columnMapping?.region) {
    return NextResponse.json(
      { error: "Missing rows or column mapping" },
      { status: 400 }
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

    try {
      const existing = await prisma.regionData.findUnique({
        where: { country },
      });

      if (existing) {
        if (existing.region !== region) {
          await prisma.regionData.update({
            where: { country },
            data: { region },
          });
          updated++;
        } else {
          skipped++;
        }
      } else {
        await prisma.regionData.create({
          data: { country, region },
        });
        imported++;
      }
    } catch (err) {
      errors.push(
        `Row ${rowNum}: Failed to import "${country}" - ${err instanceof Error ? err.message : String(err)}`
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
