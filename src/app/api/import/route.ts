import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { computeExpiryDate, parseDate } from "@/lib/utils";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds, isSuperAdmin } from "@/lib/company-scope";

interface ImportRow {
  fullName: string;
  email: string;
  theatre: string;
  country: string;
  title: string;
  completedDate: string;
  company: string;
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
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const body = await request.json();
  const { rows, columnMapping, defaultCompanyId } = body as {
    rows: Record<string, string>[];
    columnMapping: Record<string, string>;
    defaultCompanyId?: number;
  };

  if (!rows || !columnMapping) {
    return NextResponse.json(
      { error: "Missing rows or columnMapping" },
      { status: 400 }
    );
  }

  const allowedCompanyIds = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const callerIsSuperAdmin = isSuperAdmin(auth.role);

  // Resolve the default company. Required for non-SuperAdmin callers; optional
  // for SuperAdmin (used as a fallback only when a row has no Company column).
  let defaultCompany: { id: number; name: string } | null = null;
  if (defaultCompanyId !== undefined && defaultCompanyId !== null) {
    const cid = Number(defaultCompanyId);
    if (!Number.isInteger(cid)) {
      return NextResponse.json({ error: "Invalid defaultCompanyId" }, { status: 400 });
    }
    if (!(await canAccessCompany(auth.sub, auth.role, cid))) {
      return NextResponse.json({ error: "You do not have access to that company" }, { status: 403 });
    }
    const found = await prisma.company.findUnique({ where: { id: cid }, select: { id: true, name: true } });
    if (!found) return NextResponse.json({ error: "Default company not found" }, { status: 404 });
    defaultCompany = found;
  }

  // Cache loaded/created companies by lowercased name
  const companyCache = new Map<string, { id: number; name: string }>();
  if (defaultCompany) companyCache.set(defaultCompany.name.toLowerCase(), defaultCompany);

  const summary = {
    studentsCreated: 0,
    studentsUpdated: 0,
    trainingsCreated: 0,
    trainingsSkipped: 0,
    trainingsAutoCreated: 0,
    companiesCreated: 0,
    companyConflicts: 0,
    errors: [] as string[],
  };

  // Map rows using column mapping
  const mappedRows: ImportRow[] = rows.map((row) => {
    const rawEmail = (row[columnMapping.email] || "").trim();
    const email = rawEmail.toLowerCase();
    const rawFullName = (row[columnMapping.fullName] || "").trim();
    const fullName = rawFullName ? titleCase(rawFullName) : deriveFullName(email);
    const company = (columnMapping.company ? (row[columnMapping.company] || "").trim() : "");

    return {
      fullName,
      email,
      theatre: row[columnMapping.theatre] || "",
      country: row[columnMapping.country] || "",
      title: row[columnMapping.title] || "",
      completedDate: row[columnMapping.completedDate] || "",
      company,
    };
  });

  for (let i = 0; i < mappedRows.length; i++) {
    const row = mappedRows[i];
    const rowNum = i + 2;

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

    // ─── Resolve the company for this row ────────────────────────────────────
    let rowCompany: { id: number; name: string } | null = null;
    const rowCompanyName = row.company.trim();

    if (rowCompanyName) {
      const cached = companyCache.get(rowCompanyName.toLowerCase());
      if (cached) {
        rowCompany = cached;
      } else {
        const found = await prisma.company.findUnique({
          where: { name: rowCompanyName },
          select: { id: true, name: true },
        });
        if (found) {
          rowCompany = found;
          companyCache.set(found.name.toLowerCase(), found);
        } else if (callerIsSuperAdmin) {
          // SuperAdmin: auto-create unknown companies on the fly.
          const created = await prisma.company.create({
            data: { name: rowCompanyName },
            select: { id: true, name: true },
          });
          rowCompany = created;
          companyCache.set(created.name.toLowerCase(), created);
          summary.companiesCreated++;
        } else {
          summary.errors.push(
            `Row ${rowNum}: Company "${rowCompanyName}" does not exist. Ask a SuperAdmin to create it.`
          );
          continue;
        }
      }
    } else if (defaultCompany) {
      rowCompany = defaultCompany;
    } else {
      summary.errors.push(`Row ${rowNum}: No company specified and no default company selected`);
      continue;
    }

    // Caller must have access to the company they're importing into.
    if (allowedCompanyIds !== null && !allowedCompanyIds.includes(rowCompany.id)) {
      summary.errors.push(`Row ${rowNum}: Out of scope — you do not have access to "${rowCompany.name}".`);
      continue;
    }

    try {
      // Upsert student
      const existingStudent = await prisma.student.findUnique({
        where: { email: row.email },
      });

      let studentCompanyId = rowCompany.id;

      if (existingStudent) {
        // If the existing student's company is outside the caller's scope, reject.
        if (allowedCompanyIds !== null && !allowedCompanyIds.includes(existingStudent.companyId)) {
          summary.errors.push(
            `Row ${rowNum}: Out of scope — student ${row.email} belongs to a company you cannot access.`
          );
          continue;
        }

        // Warn if the row's company differs from the existing assignment.
        if (existingStudent.companyId !== rowCompany.id) {
          summary.companyConflicts++;
          summary.errors.push(
            `Row ${rowNum}: ${row.email} is already assigned to a different company; the row's company "${rowCompany.name}" was ignored. Reassign manually if required.`
          );
        }
        studentCompanyId = existingStudent.companyId;
        summary.studentsUpdated++;
      } else {
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
            companyId: studentCompanyId,
          },
        });
        summary.studentsCreated++;
      }

      const trainingExists = await prisma.trainingData.findUnique({
        where: { trainingTitle: row.title },
      });

      if (!trainingExists) {
        await prisma.trainingData.upsert({
          where: { trainingTitle: row.title },
          update: {},
          create: {
            trainingTitle: row.title,
            fullTitle: row.title,
            trainingType: "Certification",
            productType: "Cortex",
            function: "Sales",
            isIncomplete: true,
          },
        });
        summary.trainingsAutoCreated++;
      }

      const expiryDate = computeExpiryDate(completedDate);
      const existingTraining = await prisma.trainingTaken.findFirst({
        where: { email: row.email, trainingTitle: row.title, completedDate: completedDate },
      });

      if (existingTraining) {
        summary.trainingsSkipped++;
        continue;
      }

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

  await prisma.importMetadata.upsert({
    where: { key: "students" },
    update: { timestamp: new Date() },
    create: { key: "students", timestamp: new Date() },
  });

  return NextResponse.json(summary);
}
