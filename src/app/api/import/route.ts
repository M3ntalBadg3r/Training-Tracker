import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { computeExpiryDate, parseDate } from "@/lib/utils";
import { requireAuth, handleAuthError } from "@/lib/auth";

interface ImportRow {
  fullName: string;
  email: string;
  theatre: string;
  country: string;
  title: string;
  completedDate: string;
}

function titleCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, (char) => char.toUpperCase());
}

function deriveFullName(email: string): string {
  const localPart = email.split("@")[0];
  const parts = localPart.split(".");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return titleCase(`${parts[0]} ${parts[1]}`);
  }
  return email;
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
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
  const mappedRows: ImportRow[] = rows.map((row) => {
    const rawEmail = (row[columnMapping.email] || "").trim();
    const email = rawEmail.toLowerCase();
    const rawFullName = (row[columnMapping.fullName] || "").trim();
    const fullName = rawFullName
      ? titleCase(rawFullName)
      : deriveFullName(email);

    return {
      fullName,
      email,
      theatre: row[columnMapping.theatre] || "",
      country: row[columnMapping.country] || "",
      title: row[columnMapping.title] || "",
      completedDate: row[columnMapping.completedDate] || "",
    };
  });

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
      console.error(`Import row ${rowNum} error:`, error);
      const safeMessage = error instanceof Error && error.message.includes("Unique constraint")
        ? "Duplicate entry"
        : "Failed to process";
      summary.errors.push(`Row ${rowNum}: ${safeMessage}`);
    }
  }

  // Record last import timestamp for students
  await prisma.importMetadata.upsert({
    where: { key: "students" },
    update: { timestamp: new Date() },
    create: { key: "students", timestamp: new Date() },
  });

  return NextResponse.json(summary);
}
