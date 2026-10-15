import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds } from "@/lib/company-scope";
import { readJsonBody } from "@/lib/request-body";
import { invalidateReportCache } from "@/lib/report-cache";
import { isAnchoredProgram } from "@/lib/program-anchor";
import { MINIMUM_COUNTRIES_ERROR, parseMinimumCountries } from "@/lib/program-data-write";
import { parsePositiveId } from "../route";

/**
 * Bulk import for Program Partners — `POST /api/admin/program-company-settings/import`
 * (`?dryRun=true` validates and previews without writing).
 *
 * Body: `{ rows: [{ program, company?, minimumCountries?, targetCountrySet? }],
 * defaultCompanyId?, minimumMapped?, targetMapped? }`. The columns are the
 * page export's own (Program / Company / Minimum Target Countries / Target
 * Country Set), so an exported file round-trips.
 *
 * Semantics, mirroring the Country Sets import:
 *  - **One row per (program, company), upserted.** Rows not named in the file
 *    are untouched. A second row for the same pair is an error (the first wins).
 *  - **Company per row**, from the Company cell or, when blank, the dialog's
 *    `defaultCompanyId`. Matched by name among the companies the caller may
 *    access only — exactly first, then case-insensitively when unambiguous. A
 *    company the caller cannot access gets the SAME message as one that does
 *    not exist, so the import cannot discover other tenants' names.
 *  - **Program** by name (exact, then case-insensitive when unambiguous), and
 *    only an anchored program — partner terms mean nothing on any other.
 *  - **Target Country Set** by name within that row's company only (a set of
 *    another company resolves exactly like a missing one).
 *  - An unmapped column, or a blank cell, writes nothing: an existing row keeps
 *    its value and a new row starts empty. `none` (or a dash) clears it.
 *  - A row whose values already match is reported `unchanged` and not written.
 */

const MAX_ROWS = 10_000;
const MAX_ERRORS = 500;
const DASHES = new Set(["", "—", "-", "–"]);
const CLEAR_MARKERS = new Set(["—", "-", "–", "n/a", "none"]);

interface RawRow {
  program?: unknown;
  company?: unknown;
  minimumCountries?: unknown;
  targetCountrySet?: unknown;
}

type Cell = { ok: true; value: string } | { ok: false };
function cell(v: unknown): Cell {
  if (v === undefined || v === null) return { ok: true, value: "" };
  if (typeof v === "string") return { ok: true, value: v.trim() };
  if (typeof v === "number" && Number.isFinite(v)) return { ok: true, value: String(v) };
  return { ok: false };
}

/** Exact match first, then case-insensitive only when exactly one candidate. */
function matchByName<T extends { name: string }>(list: T[], text: string): { one: T } | { many: true } | null {
  const exact = list.find((x) => x.name === text);
  if (exact) return { one: exact };
  const loose = list.filter((x) => x.name.trim().toLowerCase() === text.toLowerCase());
  if (loose.length === 1) return { one: loose[0] };
  if (loose.length > 1) return { many: true };
  return null;
}

interface Planned {
  row: number;
  programId: number;
  programName: string;
  companyId: number;
  companyName: string;
  /** `undefined` = leave alone. */
  minimumCountries: number | null | undefined;
  /** `undefined` = leave alone. */
  targetCountrySetId: number | null | undefined;
  targetCountrySetName: string | null | undefined;
}

export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "No rows provided" }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `Too many rows in a single import (max ${MAX_ROWS.toLocaleString()}).` }, { status: 413 });
  }
  const minimumMapped = body.minimumMapped === true;
  const targetMapped = body.targetMapped === true;

  // The default company must be one the caller may access — checked before
  // anything else is read, like the POST.
  let defaultCompanyId: number | null = null;
  if (body.defaultCompanyId != null && body.defaultCompanyId !== "") {
    defaultCompanyId = parsePositiveId(body.defaultCompanyId);
    if (defaultCompanyId === null) {
      return NextResponse.json({ error: "Invalid default company" }, { status: 400 });
    }
    if (!(await canAccessCompany(auth.sub, auth.role, defaultCompanyId))) {
      return NextResponse.json({ error: "You do not have access to that company" }, { status: 403 });
    }
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companies = await prisma.company.findMany({
    where: allowed ? { id: { in: allowed } } : {},
    select: { id: true, name: true },
  });
  const companyById = new Map(companies.map((c) => [c.id, c]));
  if (defaultCompanyId !== null && !companyById.has(defaultCompanyId)) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  const programs = (
    await prisma.program.findMany({ select: { id: true, name: true, anchorTheatre: true } })
  );

  const errors: { row: number; message: string }[] = [];
  const addError = (row: number, message: string) => {
    if (errors.length < MAX_ERRORS) errors.push({ row, message });
  };

  // First pass: resolve program + company per row, so the sets of every
  // company involved can be fetched in one query.
  interface Stage1 {
    row: number;
    program: { id: number; name: string };
    company: { id: number; name: string };
    minimumText: string;
    targetText: string;
  }
  const stage1: Stage1[] = [];
  let blankRows = 0;
  rows.forEach((raw: RawRow, i) => {
    const rowNo = i + 1;
    const r: RawRow = raw && typeof raw === "object" ? raw : {};
    const programCell = cell(r.program);
    const companyCell = cell(r.company);
    const minimumCell = cell(r.minimumCountries);
    const targetCell = cell(r.targetCountrySet);
    if (!programCell.ok || !companyCell.ok || !minimumCell.ok || !targetCell.ok) {
      addError(rowNo, "Every cell must be text");
      return;
    }
    // A wholly blank row (a trailing line) is not an error.
    if (!programCell.value && !companyCell.value && !minimumCell.value && !targetCell.value) {
      blankRows++;
      return;
    }

    if (DASHES.has(programCell.value)) {
      addError(rowNo, "Program is required");
      return;
    }
    const pm = matchByName(programs, programCell.value);
    if (!pm) {
      addError(rowNo, `Program "${programCell.value.slice(0, 80)}" was not found`);
      return;
    }
    if ("many" in pm) {
      addError(rowNo, `Program "${programCell.value.slice(0, 80)}" matches more than one program — use the exact name`);
      return;
    }
    if (!isAnchoredProgram(pm.one)) {
      addError(rowNo, `Program "${pm.one.name}" is not anchored — partner settings apply only to anchored programs`);
      return;
    }

    let company: { id: number; name: string } | undefined;
    if (!DASHES.has(companyCell.value)) {
      const cm = matchByName(companies, companyCell.value);
      if (!cm) {
        // Same message whether missing or out of scope — no tenant-name oracle.
        addError(rowNo, `Company "${companyCell.value.slice(0, 80)}" was not found, or you do not have access to it`);
        return;
      }
      if ("many" in cm) {
        addError(rowNo, `Company "${companyCell.value.slice(0, 80)}" matches more than one company — use the exact name`);
        return;
      }
      company = cm.one;
    } else if (defaultCompanyId !== null) {
      company = companyById.get(defaultCompanyId);
    }
    if (!company) {
      addError(rowNo, "Company is required — fill the Company column or choose a default company");
      return;
    }
    stage1.push({
      row: rowNo,
      program: { id: pm.one.id, name: pm.one.name },
      company,
      minimumText: minimumMapped ? minimumCell.value : "",
      targetText: targetMapped ? targetCell.value : "",
    });
  });

  const companyIds = [...new Set(stage1.map((s) => s.company.id))];
  const sets = companyIds.length
    ? await prisma.countrySet.findMany({
        where: { companyId: { in: companyIds } },
        select: { id: true, companyId: true, name: true },
      })
    : [];
  const setsByCompany = new Map<number, { id: number; name: string }[]>();
  for (const s of sets) setsByCompany.set(s.companyId, [...(setsByCompany.get(s.companyId) ?? []), s]);

  const pairKey = (programId: number, companyId: number) => `${programId}:${companyId}`;
  const seen = new Map<string, number>();
  const planned: Planned[] = [];
  for (const s of stage1) {
    const key = pairKey(s.program.id, s.company.id);
    const first = seen.get(key);
    if (first !== undefined) {
      addError(s.row, `Duplicates row ${first} (same program and company) — only the first is used`);
      continue;
    }

    let minimumCountries: number | null | undefined;
    if (s.minimumText === "") minimumCountries = undefined;
    else if (CLEAR_MARKERS.has(s.minimumText.toLowerCase())) minimumCountries = null;
    else {
      const m = parseMinimumCountries(s.minimumText);
      if (!m.ok || m.value === null) {
        addError(s.row, `Minimum Target Countries "${s.minimumText.slice(0, 20)}": ${MINIMUM_COUNTRIES_ERROR}`);
        continue;
      }
      minimumCountries = m.value;
    }

    let targetCountrySetId: number | null | undefined;
    let targetCountrySetName: string | null | undefined;
    if (s.targetText === "") targetCountrySetId = undefined;
    else if (CLEAR_MARKERS.has(s.targetText.toLowerCase())) {
      targetCountrySetId = null;
      targetCountrySetName = null;
    } else {
      const sm = matchByName(setsByCompany.get(s.company.id) ?? [], s.targetText);
      if (!sm || "many" in sm) {
        addError(
          s.row,
          `Country set "${s.targetText.slice(0, 80)}" was not found for ${s.company.name}${sm ? " (more than one matches — use the exact name)" : ""}`
        );
        continue;
      }
      targetCountrySetId = sm.one.id;
      targetCountrySetName = sm.one.name;
    }

    // Recorded only once the row is valid, so an invalid first row does not
    // shadow a valid later one for the same pair.
    seen.set(key, s.row);
    planned.push({
      row: s.row,
      programId: s.program.id,
      programName: s.program.name,
      companyId: s.company.id,
      companyName: s.company.name,
      minimumCountries,
      targetCountrySetId,
      targetCountrySetName,
    });
  }

  const existing = planned.length
    ? await prisma.programCompanySetting.findMany({
        where: {
          programId: { in: [...new Set(planned.map((p) => p.programId))] },
          companyId: { in: [...new Set(planned.map((p) => p.companyId))] },
        },
        select: { id: true, programId: true, companyId: true, minimumCountries: true, targetCountrySetId: true },
      })
    : [];
  const existingByKey = new Map(existing.map((e) => [pairKey(e.programId, e.companyId), e]));

  const actionOf = (p: Planned): "create" | "update" | "unchanged" => {
    const e = existingByKey.get(pairKey(p.programId, p.companyId));
    if (!e) return "create";
    const sameMin = p.minimumCountries === undefined || p.minimumCountries === e.minimumCountries;
    const sameSet = p.targetCountrySetId === undefined || p.targetCountrySetId === e.targetCountrySetId;
    return sameMin && sameSet ? "unchanged" : "update";
  };
  const actions = planned.map((p) => ({ p, action: actionOf(p) }));
  const count = (a: string) => actions.filter((x) => x.action === a).length;
  const summary = {
    created: count("create"),
    updated: count("update"),
    unchanged: count("unchanged"),
    skipped: rows.length - blankRows - planned.length,
    errors: [...errors].sort((a, b) => a.row - b.row),
    errorsTruncated: errors.length >= MAX_ERRORS,
  };
  const preview = actions.slice(0, 200).map(({ p, action }) => ({
    program: p.programName,
    company: p.companyName,
    minimumCountries: p.minimumCountries,
    targetCountrySet: p.targetCountrySetName,
    action,
  }));

  if (dryRun) return NextResponse.json({ dryRun: true, ...summary, rows: preview });

  const toCreate = actions.filter((a) => a.action === "create").map((a) => a.p);
  const toUpdate = actions.filter((a) => a.action === "update").map((a) => a.p);
  const written = [...new Set([...toCreate, ...toUpdate].map((p) => p.companyId))];

  if (toCreate.length + toUpdate.length > 0) {
    try {
      await prisma.$transaction(
        async (tx) => {
          if (toCreate.length) {
            await tx.programCompanySetting.createMany({
              data: toCreate.map((p) => ({
                programId: p.programId,
                companyId: p.companyId,
                minimumCountries: p.minimumCountries ?? null,
                targetCountrySetId: p.targetCountrySetId ?? null,
              })),
            });
          }
          for (const p of toUpdate) {
            const e = existingByKey.get(pairKey(p.programId, p.companyId))!;
            await tx.programCompanySetting.update({
              where: { id: e.id, companyId: p.companyId },
              data: {
                ...(p.minimumCountries !== undefined ? { minimumCountries: p.minimumCountries } : {}),
                ...(p.targetCountrySetId !== undefined ? { targetCountrySetId: p.targetCountrySetId } : {}),
              },
            });
          }
        },
        { maxWait: 10_000, timeout: 60_000 }
      );
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      // A row created or deleted concurrently: the preview no longer describes
      // the database — ask for a retry rather than a bare 500.
      if (code === "P2002" || code === "P2025" || code === "P2003") {
        return NextResponse.json(
          { error: "Partner settings changed while importing — preview and import again" },
          { status: 409 }
        );
      }
      console.warn("program-company-settings import failed", err);
      return NextResponse.json({ error: "Import failed" }, { status: 500 });
    }
    invalidateReportCache();
  }

  return NextResponse.json({ ...summary, companyIds: written });
}
