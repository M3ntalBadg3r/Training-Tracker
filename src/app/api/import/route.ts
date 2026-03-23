import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { computeExpiryDate, parseDate } from "@/lib/utils";

interface ImportRow {
  fullName: string;
  email: string;
  theatre: string;
  country: string;
  title: string;
  completedDate: string;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { rows, columnMapping } = body as {
    rows: Record<string, string>[];
    columnMapping: Record<string, string>;
  };

  if (!rows || !columnMapping) {
    return NextResponse.json(
      { error: "Missing rows or columnMapping" },
      { status: 400 }
    );
  }

  const summary = {
    studentsCreated: 0,
    studentsUpdated: 0,
    trainingsCreated: 0,
    trainingsSkipped: 0,
    errors: [] as string[],
  };

  // Map rows using column mapping
  const mappedRows: ImportRow[] = rows.map((row) => ({
    fullName: row[columnMapping.fullName] || "",
    email: row[columnMapping.email] || "",
    theatre: row[columnMapping.theatre] || "",
    country: row[columnMapping.country] || "",
    title: row[columnMapping.title] || "",
    completedDate: row[columnMapping.completedDate] || "",
  }));

  for (let i = 0; i < mappedRows.length; i++) {
    const row = mappedRows[i];
    const rowNum = i + 2; // +2 because row 1 is header

    // Validate required fields
    if (!row.email) {
      summary.errors.push(`Row ${rowNum}: Missing email address`);
      continue;
    }
    if (!row.fullName) {
      summary.errors.push(`Row ${rowNum}: Missing full name for ${row.email}`);
      continue;
    }
    if (!row.title) {
      summary.errors.push(`Row ${rowNum}: Missing training title for ${row.email}`);
      continue;
    }
    if (!row.completedDate) {
      summary.errors.push(`Row ${rowNum}: Missing completed date for ${row.email}`);
      continue;
    }

    const completedDate = parseDate(row.completedDate);
    if (!completedDate) {
      summary.errors.push(
        `Row ${rowNum}: Invalid date format "${row.completedDate}" for ${row.email}`
      );
      continue;
    }

    try {
      // Upsert student
      const existingStudent = await prisma.student.findUnique({
        where: { email: row.email },
      });

      if (existingStudent) {
        summary.studentsUpdated++;
      } else {
        // Ensure the country exists in region_data before creating the student
        if (row.country) {
          const regionExists = await prisma.regionData.findUnique({
            where: { country: row.country },
          });
          if (!regionExists) {
            await prisma.regionData.create({
              data: { country: row.country, region: "Unknown" },
            });
          }
        }

        await prisma.student.create({
          data: {
            email: row.email,
            fullName: row.fullName,
            theatre: row.theatre,
            country: row.country,
          },
        });
        summary.studentsCreated++;
      }

      // Check if training title exists in training_data
      const trainingExists = await prisma.trainingData.findUnique({
        where: { trainingTitle: row.title },
      });

      if (!trainingExists) {
        summary.errors.push(
          `Row ${rowNum}: Training title "${row.title}" not found in training data for ${row.email}`
        );
        continue;
      }

      // Check for duplicate training taken
      const expiryDate = computeExpiryDate(completedDate);
      const existingTraining = await prisma.trainingTaken.findFirst({
        where: {
          email: row.email,
          trainingTitle: row.title,
          completedDate: completedDate,
        },
      });

      if (existingTraining) {
        summary.trainingsSkipped++;
        continue;
      }

      // Create training taken record
      await prisma.trainingTaken.create({
        data: {
          email: row.email,
          trainingTitle: row.title,
          completedDate: completedDate,
          expiryDate: expiryDate,
        },
      });
      summary.trainingsCreated++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`Row ${rowNum}: ${message}`);
    }
  }

  return NextResponse.json(summary);
}
