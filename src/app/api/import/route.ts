import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { titleCaseName, deriveNameFromEmail } from "@/lib/utils";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds, isSuperAdmin } from "@/lib/company-scope";
import { recomputeParentsForMany } from "@/lib/olx";
import { detectFormat, isDateFormat, type DateFormat } from "@/lib/date-format";
import { getSystemDateFormat } from "@/lib/system-settings";
import { invalidateReportCache } from "@/lib/report-cache";
import { readJsonBody } from "@/lib/request-body";
import {
  runStudentImport,
  stampImportMetadata,
  type ImportRow,
  type ImportSummary,
} from "@/lib/student-import";

export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
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

  const summary: ImportSummary = {
    studentsCreated: 0,
    studentsUpdated: 0,
    trainingsCreated: 0,
    trainingsSkipped: 0,
    trainingsAutoCreated: 0,
    companiesCreated: 0,
    companyConflicts: 0,
    // Only claim a format when a cell actually needed one. Native Excel date
    // cells reach us as ISO and are parsed verbatim, so saying they were
    // "parsed as DD/MM/YYYY" would describe a decision that never happened.
    dateFormatUsed: detection.examined > 0 ? effectiveFormat : null,
    errors: [] as string[],
  };

  // `ambiguous` now implies at least one text date cell was read, so no
  // row-count guard is needed. Name how many cells the note is about when the
  // column also held unambiguous ISO dates, so "All dates" stays truthful.
  if (detection.ambiguous) {
    const scope =
      detection.iso > 0
        ? `${detection.examined} text ${detection.examined === 1 ? "date" : "dates"}`
        : "All dates";
    summary.errors.push(
      `${scope} fit both DD/MM/YYYY and MM/DD/YYYY — parsed as ${effectiveFormat} (the ${overrideFormat ? "override for this import" : "system default"}).`
    );
  }

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
      fullName = titleCaseName(rawFullName);
    } else if (rawFirst || rawLast) {
      fullName = titleCaseName(`${rawFirst} ${rawLast}`);
    } else {
      // Never fall back to the raw address — that writes an email into the name
      // field, which is precisely the "Email as Name" defect Data Clean-Up exists
      // to fix. The `||` is also load-bearing: an empty name hits the guard below
      // and drops the whole training record, not just the name.
      fullName = deriveNameFromEmail(email) || email.split("@")[0];
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

  // The write phase is batched (see lib/student-import.ts): per-row rules,
  // messages and counters are unchanged, but the round trips scale with
  // rows / batch size rather than with rows.
  const { recomputePairs, touchedCompanies } = await runStudentImport({
    rows: mappedRows,
    effectiveFormat,
    defaultCompany,
    allowedCompanyIds,
    callerIsSuperAdmin,
    summary,
  });

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

  // Global stamp plus per-company stamps, so the Students page can show the
  // last import for the currently selected company (blank when that company
  // has never imported).
  await stampImportMetadata(touchedCompanies, new Date());

  invalidateReportCache();
  return NextResponse.json(summary);
}
