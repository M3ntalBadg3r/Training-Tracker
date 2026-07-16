import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { computeExpiryDate } from "@/lib/utils";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds, isSuperAdmin } from "@/lib/company-scope";
import { recomputeParentsForMany } from "@/lib/olx";
import { detectFormat, isDateFormat, parseDateWith, type DateFormat } from "@/lib/date-format";
import { getSystemDateFormat } from "@/lib/system-settings";
import { ensureDefaultProductTypeId } from "@/lib/product-types";
import { invalidateReportCache } from "@/lib/report-cache";

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
  const { rows, columnMapping, defaultCompanyId, dateFormatOverride } = body as {
    rows: Record<string, string>[];
    columnMapping: Record<string, string>;
    defaultCompanyId?: number;
    // Per-import override: when the UI confirms a format-mismatch warning, it
    // resubmits with this field set. Validated against the allowed list below.
    dateFormatOverride?: string;
  };

  if (!rows || !columnMapping) {
    return NextResponse.json(
      { error: "Missing rows or columnMapping" },
      { status: 400 }
    );
  }
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: "rows must be an array" }, { status: 400 });
  }
  if (rows.length > 50_000) {
    return NextResponse.json(
      { error: "Too many rows in a single import (max 50,000). Split the file and retry." },
      { status: 413 }
    );
  }

  // ─── Determine the effective date format for this import ────────────────
  // 1. Sample the completedDate column and detect the most likely format.
  // 2. Compare against the system default. If the per-import override matches
  //    the detected format, use it. Otherwise, if there's a conflict, return
  //    a 409 with the evidence so the UI can prompt the user.
  const systemDateFormat = await getSystemDateFormat();
  const overrideFormat = isDateFormat(dateFormatOverride) ? dateFormatOverride : null;
  const completedColumn = columnMapping.completedDate;
  const sampledValues = completedColumn
    ? rows.map((r) => r[completedColumn] ?? "").filter((v) => typeof v === "string")
    : [];
  const detection = detectFormat(sampledValues);

  // Conflict: cells force a format that disagrees with the assumed format
  // (the override if provided, otherwise the system default).
  const assumed: DateFormat = overrideFormat ?? systemDateFormat;
  if (
    detection.format &&
    detection.format !== assumed &&
    detection.conflicts.length === 0
  ) {
    const sampleConflicts: { row: number; value: string }[] = [];
    if (completedColumn) {
      for (let i = 0; i < rows.length && sampleConflicts.length < 5; i++) {
        const raw = rows[i][completedColumn];
        if (typeof raw !== "string") continue;
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
        if (!m) continue;
        const a = Number(m[1]);
        const b = Number(m[2]);
        const fitsAssumed =
          assumed === "DD/MM/YYYY"
            ? a >= 1 && a <= 31 && b >= 1 && b <= 12
            : a >= 1 && a <= 12 && b >= 1 && b <= 31;
        if (!fitsAssumed) sampleConflicts.push({ row: i + 2, value: raw.trim() });
      }
    }
    return NextResponse.json(
      {
        error: "dateFormatMismatch",
        assumedFormat: assumed,
        detectedFormat: detection.format,
        sampleConflicts,
      },
      { status: 409 }
    );
  }

  // Internal conflicts (some cells force DD/MM, others MM/DD) → also bail.
  if (detection.conflicts.length === 2) {
    return NextResponse.json(
      {
        error: "dateFormatInconsistent",
        message: "Date column contains values in both DD/MM/YYYY and MM/DD/YYYY formats.",
      },
      { status: 409 }
    );
  }

  const effectiveFormat: DateFormat = assumed;

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

  // Cache RegionData lookups by country (case-sensitive, mirroring the column).
  // Keeps the per-row lookup cheap and lets us record auto-created entries once.
  const regionCache = new Map<string, { country: string; region: string; theatre: string | null }>();

  const summary = {
    studentsCreated: 0,
    studentsUpdated: 0,
    trainingsCreated: 0,
    trainingsSkipped: 0,
    trainingsAutoCreated: 0,
    companiesCreated: 0,
    companyConflicts: 0,
    dateFormatUsed: effectiveFormat,
    errors: [] as string[],
  };

  if (detection.ambiguous && sampledValues.length > 0) {
    summary.errors.push(
      `All dates fit both DD/MM/YYYY and MM/DD/YYYY — parsed as ${effectiveFormat} (the ${overrideFormat ? "override for this import" : "system default"}).`
    );
  }

  // Track (email, trainingTitle) pairs for OLX parent recomputation after
  // the loop. We can't know yet which titles are sub-items; we'll filter at
  // recompute time using the join table.
  const recomputePairs: { email: string; subItemTrainingTitle: string }[] = [];

  // Map rows using column mapping
  const mappedRows: ImportRow[] = rows.map((row) => {
    const rawEmail = (row[columnMapping.email] || "").trim();
    const email = rawEmail.toLowerCase();
    // Name: prefer an explicit Full Name; otherwise merge First + Last; otherwise
    // derive from the email local part. Resolved per-row so a file with all three
    // columns (or a Full Name file with blank rows) degrades gracefully.
    const rawFullName = (row[columnMapping.fullName] || "").trim();
    const rawFirst = (columnMapping.firstName ? row[columnMapping.firstName] || "" : "").trim();
    const rawLast = (columnMapping.lastName ? row[columnMapping.lastName] || "" : "").trim();
    let fullName: string;
    if (rawFullName) {
      fullName = titleCase(rawFullName);
    } else if (rawFirst || rawLast) {
      fullName = titleCase(`${rawFirst} ${rawLast}`.replace(/\s+/g, " ").trim());
    } else {
      fullName = deriveFullName(email);
    }
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

  // Resolved lazily on first auto-create of a training row (see below).
  let cachedDefaultProductTypeId: number | undefined;

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

    const completedDate = parseDateWith(row.completedDate, effectiveFormat);
    if (!completedDate) {
      summary.errors.push(
        `Row ${rowNum}: Invalid date "${row.completedDate}" — expected ${effectiveFormat} for ${row.email}`
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
      // ─── Resolve theatre via RegionData (source of truth) ──────────────────
      // - Country known with theatre set: warn if the row's theatre differs,
      //   then use the RegionData theatre.
      // - Country known with no theatre: keep row's theatre, warn so the
      //   SuperAdmin populates RegionData.
      // - Country unknown: auto-create RegionData (region "Unknown"), keep
      //   row's theatre, warn.
      const csvTheatre = (row.theatre || "").trim();
      let resolvedTheatre = csvTheatre;
      if (row.country) {
        let rd = regionCache.get(row.country);
        if (!rd) {
          const found = await prisma.regionData.findUnique({ where: { country: row.country } });
          if (found) {
            rd = { country: found.country, region: found.region, theatre: found.theatre };
          } else {
            const created = await prisma.regionData.create({
              data: { country: row.country, region: "Unknown", theatre: csvTheatre || null },
            });
            rd = { country: created.country, region: created.region, theatre: created.theatre };
            summary.errors.push(
              `Row ${rowNum}: Country "${row.country}" was not in Region Data; created with region "Unknown"${
                csvTheatre ? ` and theatre "${csvTheatre}"` : " and no theatre"
              }. Ask a SuperAdmin to verify.`
            );
          }
          regionCache.set(row.country, rd);
        }
        if (rd.theatre) {
          if (csvTheatre && csvTheatre !== rd.theatre) {
            summary.errors.push(
              `Row ${rowNum}: Theatre "${csvTheatre}" for country "${row.country}" overridden to "${rd.theatre}" (per Region Data).`
            );
          }
          resolvedTheatre = rd.theatre;
        } else if (csvTheatre) {
          // RegionData exists but no theatre yet — surface as a warning the
          // first time we see this country.
          // (Multiple rows for the same country will only warn once because of
          // the regionCache; we add the warning lazily here on every row to
          // keep the per-row context clear.)
          summary.errors.push(
            `Row ${rowNum}: Country "${row.country}" has no theatre in Region Data; using imported theatre "${csvTheatre}".`
          );
        }
      }

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
        await prisma.student.create({
          data: {
            email: row.email,
            fullName: row.fullName,
            theatre: resolvedTheatre,
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
        if (cachedDefaultProductTypeId === undefined) {
          cachedDefaultProductTypeId = await ensureDefaultProductTypeId();
        }
        await prisma.trainingData.upsert({
          where: { trainingTitle: row.title },
          update: {},
          create: {
            trainingTitle: row.title,
            fullTitle: row.title,
            trainingType: "Certification",
            productTypeId: cachedDefaultProductTypeId,
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
      recomputePairs.push({ email: row.email, subItemTrainingTitle: row.title });
    } catch (error) {
      console.error(`Import row ${rowNum} error:`, error);
      const safeMessage = error instanceof Error && error.message.includes("Unique constraint")
        ? "Duplicate entry"
        : "Failed to process";
      summary.errors.push(`Row ${rowNum}: ${safeMessage}`);
    }
  }

  // Materialise parent OLX TrainingTaken rows for any imported sub-items
  // that just completed their sibling set for a student.
  if (recomputePairs.length > 0) {
    try {
      await recomputeParentsForMany(recomputePairs);
    } catch (error) {
      console.error("OLX parent recomputation failed:", error);
      summary.errors.push("OLX parent recomputation failed — some parent OLX completions may be missing.");
    }
  }

  await prisma.importMetadata.upsert({
    where: { key: "students" },
    update: { timestamp: new Date() },
    create: { key: "students", timestamp: new Date() },
  });

  invalidateReportCache();
  return NextResponse.json(summary);
}
