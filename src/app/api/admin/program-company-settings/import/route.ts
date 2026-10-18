import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds } from "@/lib/company-scope";
import { readJsonBody } from "@/lib/request-body";
import { invalidateReportCache } from "@/lib/report-cache";
import { MAX_MINIMUM_COUNTRIES, parseMinimumCountries } from "@/lib/program-data-write";
import { parsePositiveId } from "../route";

/**
 * Bulk import for Partner Specific Program Settings — `POST /api/admin/program-company-settings/import`
 * (`?dryRun=true` validates and previews without writing).
 *
 * Body: `{ rows: [{ program, company?, countrySetMinimumCountries?, countrySet?,
 * targetMinimumCountries?, targetCountrySet? }], defaultCompanyId?,
 * countrySetMinimumMapped?, countrySetMapped?, targetMinimumMapped?,
 * targetMapped? }`. The columns are the page export's own (Program / Company /
 * Country Set Minimum / Country Set / Target Minimum / Target Country Set), so
 * an exported file round-trips. The page maps an older file's `Minimum
 * Countries` / `Minimum Target Countries` header to Target Minimum; its
 * `Target Country Set` header already means the By Theatre view's set.
 *
 * Semantics, mirroring the Country Sets import:
 *  - **One row per (program, company), upserted.** Rows not named in the file
 *    are untouched. A second row for the same pair is an error (the first wins).
 *  - **Company per row**, from the Company cell or, when blank, the dialog's
 *    `defaultCompanyId`. Matched by name among the companies the caller may
 *    access only — exactly first, then case-insensitively when unambiguous. A
 *    company the caller cannot access gets the SAME message as one that does
 *    not exist, so the import cannot discover other tenants' names.
 *  - **Program** by name (exact, then case-insensitive when unambiguous). Any
 *    program may carry partner terms.
 *  - **Country Set** and **Target Country Set** by name within that row's
 *    company only (a set of another company resolves exactly like a missing
 *    one).
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
  countrySetMinimumCountries?: unknown;
  countrySet?: unknown;
  targetMinimumCountries?: unknown;
  targetCountrySet?: unknown;
}

/** The two minimum columns: the field, its mapped flag in the body, and its column label. */
const MINIMUM_COLUMNS = [
  { field: "countrySetMinimumCountries", mapped: "countrySetMinimumMapped", label: "Country Set Minimum" },
  { field: "targetMinimumCountries", mapped: "targetMinimumMapped", label: "Target Minimum" },
] as const;
/** The two set columns: the field (and its id field), its mapped flag, and its column label. */
const SET_COLUMNS = [
  { field: "countrySet", idField: "countrySetId", mapped: "countrySetMapped", label: "Country Set" },
  { field: "targetCountrySet", idField: "targetCountrySetId", mapped: "targetMapped", label: "Target Country Set" },
] as const;
type MinimumField = (typeof MINIMUM_COLUMNS)[number]["field"];
type SetField = (typeof SET_COLUMNS)[number]["field"];
type SetIdField = (typeof SET_COLUMNS)[number]["idField"];

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
  /** Each value: `undefined` = leave alone, `null` = clear. */
  minimums: Record<MinimumField, number | null | undefined>;
  setIds: Record<SetIdField, number | null | undefined>;
  setNames: Record<SetField, string | null | undefined>;
}

/** The entries whose value is not `undefined` ("leave alone"). */
function definedOnly<K extends string>(o: Record<K, number | null | undefined>): Partial<Record<K, number | null>> {
  const out: Partial<Record<K, number | null>> = {};
  for (const [k, v] of Object.entries(o) as [K, number | null | undefined][]) if (v !== undefined) out[k] = v;
  return out;
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
  const mapped = (flag: string) => body[flag] === true;

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

  const programs = await prisma.program.findMany({ select: { id: true, name: true } });

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
    /** Mapped cells only; an unmapped column reads as blank. */
    text: Record<MinimumField | SetField, string>;
  }
  const stage1: Stage1[] = [];
  let blankRows = 0;
  rows.forEach((raw: RawRow, i) => {
    const rowNo = i + 1;
    const r: RawRow = raw && typeof raw === "object" ? raw : {};
    const programCell = cell(r.program);
    const companyCell = cell(r.company);
    const valueCells = [...MINIMUM_COLUMNS, ...SET_COLUMNS].map((c) => ({ col: c, cell: cell(r[c.field]) }));
    if (!programCell.ok || !companyCell.ok || valueCells.some((v) => !v.cell.ok)) {
      addError(rowNo, "Every cell must be text");
      return;
    }
    const text = {} as Record<MinimumField | SetField, string>;
    for (const { col, cell: c } of valueCells) text[col.field] = c.ok && mapped(col.mapped) ? c.value : "";
    // A wholly blank row (a trailing line) is not an error.
    if (!programCell.value && !companyCell.value && valueCells.every((v) => v.cell.ok && !v.cell.value)) {
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
      text,
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

    const minimums = {} as Planned["minimums"];
    let rowError: string | null = null;
    for (const col of MINIMUM_COLUMNS) {
      const t = s.text[col.field];
      if (t === "") minimums[col.field] = undefined;
      else if (CLEAR_MARKERS.has(t.toLowerCase())) minimums[col.field] = null;
      else {
        const m = parseMinimumCountries(t);
        if (!m.ok || m.value === null) {
          rowError = `${col.label} "${t.slice(0, 20)}" must be a whole number from 1 to ${MAX_MINIMUM_COUNTRIES}`;
          break;
        }
        minimums[col.field] = m.value;
      }
    }

    const setIds = {} as Planned["setIds"];
    const setNames = {} as Planned["setNames"];
    if (!rowError) {
      for (const col of SET_COLUMNS) {
        const t = s.text[col.field];
        if (t === "") {
          setIds[col.idField] = undefined;
          setNames[col.field] = undefined;
        } else if (CLEAR_MARKERS.has(t.toLowerCase())) {
          setIds[col.idField] = null;
          setNames[col.field] = null;
        } else {
          const sm = matchByName(setsByCompany.get(s.company.id) ?? [], t);
          if (!sm || "many" in sm) {
            rowError = `${col.label} "${t.slice(0, 80)}" was not found for ${s.company.name}${sm ? " (more than one matches — use the exact name)" : ""}`;
            break;
          }
          setIds[col.idField] = sm.one.id;
          setNames[col.field] = sm.one.name;
        }
      }
    }
    if (rowError) {
      addError(s.row, rowError);
      continue;
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
      minimums,
      setIds,
      setNames,
    });
  }

  const existing = planned.length
    ? await prisma.programCompanySetting.findMany({
        where: {
          programId: { in: [...new Set(planned.map((p) => p.programId))] },
          companyId: { in: [...new Set(planned.map((p) => p.companyId))] },
        },
        select: {
          id: true,
          programId: true,
          companyId: true,
          countrySetMinimumCountries: true,
          countrySetId: true,
          targetMinimumCountries: true,
          targetCountrySetId: true,
        },
      })
    : [];
  const existingByKey = new Map(existing.map((e) => [pairKey(e.programId, e.companyId), e]));

  const actionOf = (p: Planned): "create" | "update" | "unchanged" => {
    const e = existingByKey.get(pairKey(p.programId, p.companyId));
    if (!e) return "create";
    const same = (want: number | null | undefined, have: number | null) => want === undefined || want === have;
    const unchanged =
      MINIMUM_COLUMNS.every((c) => same(p.minimums[c.field], e[c.field])) &&
      SET_COLUMNS.every((c) => same(p.setIds[c.idField], e[c.idField]));
    return unchanged ? "unchanged" : "update";
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
    countrySetMinimumCountries: p.minimums.countrySetMinimumCountries,
    countrySet: p.setNames.countrySet,
    targetMinimumCountries: p.minimums.targetMinimumCountries,
    targetCountrySet: p.setNames.targetCountrySet,
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
                countrySetMinimumCountries: p.minimums.countrySetMinimumCountries ?? null,
                countrySetId: p.setIds.countrySetId ?? null,
                targetMinimumCountries: p.minimums.targetMinimumCountries ?? null,
                targetCountrySetId: p.setIds.targetCountrySetId ?? null,
              })),
            });
          }
          for (const p of toUpdate) {
            const e = existingByKey.get(pairKey(p.programId, p.companyId))!;
            await tx.programCompanySetting.update({
              where: { id: e.id, companyId: p.companyId },
              data: {
                ...definedOnly(p.minimums),
                ...definedOnly(p.setIds),
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
