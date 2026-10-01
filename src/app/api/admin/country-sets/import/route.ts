import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds } from "@/lib/company-scope";
import { readJsonBody } from "@/lib/request-body";
import { invalidateReportCache } from "@/lib/report-cache";
import { parseCompanyId } from "../route";

/**
 * Bulk import for Country Sets — `POST /api/admin/country-sets/import`
 * (`?dryRun=true` validates and reports without writing).
 *
 * Body: `{ rows: [{ company?, name, description?, countries }], defaultCompanyId?,
 * descriptionMapped? }`. The columns are the export's own (Company / Name /
 * Description / Countries), so an exported file round-trips. Several rows may
 * name the same set; their countries are unioned, which also accepts a file
 * with one country per row.
 *
 * Semantics — chosen so an import can never quietly touch a tenant it was not
 * aimed at, nor half-apply a set:
 *  - **Per-set overwrite, not merge.** A set named in the file ends up with
 *    exactly the file's countries (like the offerings and program-data
 *    imports, which overwrite what they name). Sets the file does not name are
 *    untouched. Emptying a set takes an explicit `none` in Countries: a blank
 *    cell is an error, because a Countries mapping pointed at the wrong (blank)
 *    column would otherwise empty every set the file names.
 *  - **Company per row**, from the Company cell or, when that cell is blank,
 *    the `defaultCompanyId` chosen in the dialog. The cell is matched among the
 *    companies the caller may access only — exactly first, then
 *    case-insensitively only when that is unambiguous (company names are unique
 *    with exact case, so "Acme" and "acme" can both exist, and a lower-cased map
 *    would hand the set to whichever was read last). A company the caller
 *    cannot access gets the SAME message as one that does not exist, so the
 *    import cannot be used to discover other tenants' names.
 *  - **All-or-nothing per set.** If any row of a set is invalid — an unknown
 *    country, or a company that does not resolve (in which case every set of
 *    that name is held back, since the row could have been meant for any of
 *    them) — the whole set is skipped and reported. Importing the valid
 *    remainder would overwrite a set with a silently partial country list.
 *  - Description: written only when the column is mapped and the set's rows
 *    carry a non-blank value; a blank or unmapped description leaves the stored
 *    one alone (an unmapped column writes nothing, as in the other imports).
 *  - A set whose countries and description already match is reported
 *    `unchanged` and not rewritten.
 */

const MAX_ROWS = 10_000;
const MAX_ERRORS = 500;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_COUNTRY_NAME_LENGTH = 200;
/** Placeholders a spreadsheet uses for "nothing here" in a Name/Company cell. */
const DASHES = new Set(["", "—", "-", "–"]);
/** Explicit "no countries" / "no description" markers. */
const NONE_MARKERS = new Set(["—", "-", "–", "n/a", "none"]);

interface RawRow {
  company?: unknown;
  name?: unknown;
  description?: unknown;
  countries?: unknown;
}

type Cell = { ok: true; value: string } | { ok: false };

/** A cell from an untrusted row: text or a number, never an object/array. */
function cell(v: unknown): Cell {
  if (v === undefined || v === null) return { ok: true, value: "" };
  if (typeof v === "string") return { ok: true, value: v.trim() };
  if (typeof v === "number" && Number.isFinite(v)) return { ok: true, value: String(v) };
  return { ok: false };
}

interface SetGroup {
  companyId: number;
  companyName: string;
  name: string;
  description: string | null;
  countries: Set<string>;
  explicitlyEmpty: boolean;
  firstRow: number;
  failed: boolean;
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
  const descriptionMapped = body.descriptionMapped === true;

  // The default company (for rows with a blank Company cell) must be one the
  // caller may access — checked before anything is read, like POST /country-sets.
  let defaultCompanyId: number | null = null;
  if (body.defaultCompanyId != null && body.defaultCompanyId !== "") {
    defaultCompanyId = parseCompanyId(body.defaultCompanyId);
    if (defaultCompanyId === null) {
      return NextResponse.json({ error: "Invalid default company" }, { status: 400 });
    }
    if (!(await canAccessCompany(auth.sub, auth.role, defaultCompanyId))) {
      return NextResponse.json({ error: "You do not have access to that company" }, { status: 403 });
    }
  }

  // Companies this caller may write to. `null` from getAuthorizedCompanyIds
  // means a SuperAdmin (every company).
  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companies = await prisma.company.findMany({
    where: allowed ? { id: { in: allowed } } : {},
    select: { id: true, name: true },
  });
  const companyByExactName = new Map(companies.map((c) => [c.name, c]));
  const companiesByLowerName = new Map<string, { id: number; name: string }[]>();
  for (const c of companies) {
    const k = c.name.trim().toLowerCase();
    companiesByLowerName.set(k, [...(companiesByLowerName.get(k) ?? []), c]);
  }
  const companyById = new Map(companies.map((c) => [c.id, c]));
  if (defaultCompanyId !== null && !companyById.has(defaultCompanyId)) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  type CompanyMatch = { ok: true; company: { id: number; name: string } } | { ok: false; message: string };
  const resolveCompany = (text: string): CompanyMatch => {
    const exact = companyByExactName.get(text);
    if (exact) return { ok: true, company: exact };
    const loose = companiesByLowerName.get(text.toLowerCase()) ?? [];
    if (loose.length === 1) return { ok: true, company: loose[0] };
    if (loose.length > 1) {
      return { ok: false, message: `Company "${text}" matches more than one company — use the exact name` };
    }
    // Same message whether the company is missing or out of the caller's
    // scope — the response must not confirm another tenant exists.
    return { ok: false, message: `Company "${text}" was not found, or you do not have access to it` };
  };

  // Region Data is the vocabulary of countries; match case-insensitively and
  // store the canonical spelling.
  const regionRows = await prisma.regionData.findMany({ select: { country: true } });
  const canonicalCountry = new Map(regionRows.map((r) => [r.country.trim().toLowerCase(), r.country]));

  /**
   * Resolve a Countries cell. Semicolons, pipes and new lines always separate
   * countries; commas usually do, but some country names contain one ("Korea,
   * Republic of"), so within each chunk the longest run of comma-separated
   * pieces that names a known country wins. That keeps a cell exported with
   * "; " AND a hand-typed "A, B, C" both working.
   */
  const resolveCountries = (text: string): { found: string[]; unknown: string[] } => {
    const found: string[] = [];
    const unknown: string[] = [];
    for (const chunk of text.split(/[;|\n]/)) {
      const parts = chunk.split(",").map((p) => p.trim());
      let i = 0;
      while (i < parts.length) {
        if (!parts[i]) {
          i++;
          continue;
        }
        let matched = false;
        for (let j = parts.length; j > i; j--) {
          const candidate = parts.slice(i, j).join(", ");
          if (candidate.length > MAX_COUNTRY_NAME_LENGTH) continue;
          const canonical = canonicalCountry.get(candidate.toLowerCase());
          if (canonical) {
            found.push(canonical);
            i = j;
            matched = true;
            break;
          }
        }
        if (!matched) {
          if (!NONE_MARKERS.has(parts[i].toLowerCase())) {
            unknown.push(parts[i].length > 40 ? `${parts[i].slice(0, 40)}…` : parts[i]);
          }
          i++;
        }
      }
    }
    return { found, unknown };
  };

  const errors: { row: number; message: string }[] = [];
  const addError = (row: number, message: string) => {
    if (errors.length < MAX_ERRORS) errors.push({ row, message });
  };
  const groups = new Map<string, SetGroup>();
  // Names whose rows failed before they could join a set (no resolvable
  // company): every set of that name is held back, see the header.
  const unplacedNames = new Set<string>();

  rows.forEach((raw: RawRow, i) => {
    const rowNo = i + 1;
    const r: RawRow = raw && typeof raw === "object" ? raw : {};
    const nameCell = cell(r.name);
    const companyCell = cell(r.company);
    const descriptionCell = cell(r.description);
    const countriesCell = cell(r.countries);
    if (!nameCell.ok || !companyCell.ok || !descriptionCell.ok || !countriesCell.ok) {
      addError(rowNo, "Every cell must be text");
      if (nameCell.ok && nameCell.value) unplacedNames.add(nameCell.value.toLowerCase());
      return;
    }
    const name = nameCell.value;
    const companyText = companyCell.value;
    const description = descriptionCell.value;
    const countriesText = countriesCell.value;

    // A row with nothing in it at all (a trailing blank line) is not an error.
    if (!name && !companyText && !description && !countriesText) return;

    if (DASHES.has(name)) {
      addError(rowNo, "Name is required");
      return;
    }
    if (name.length > MAX_NAME_LENGTH) {
      addError(rowNo, `Name must be ${MAX_NAME_LENGTH} characters or fewer`);
      return;
    }

    let company: { id: number; name: string } | undefined;
    if (!DASHES.has(companyText)) {
      const match = resolveCompany(companyText);
      if (!match.ok) {
        addError(rowNo, match.message);
        unplacedNames.add(name.toLowerCase());
        return;
      }
      company = match.company;
    } else if (defaultCompanyId !== null) {
      company = companyById.get(defaultCompanyId);
    }
    if (!company) {
      addError(rowNo, "Company is required — fill the Company column or choose a default company");
      unplacedNames.add(name.toLowerCase());
      return;
    }

    const key = `${company.id}\u0000${name.toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        companyId: company.id,
        companyName: company.name,
        name,
        description: null,
        countries: new Set(),
        explicitlyEmpty: false,
        firstRow: rowNo,
        failed: false,
      };
      groups.set(key, group);
    }

    if (descriptionMapped && description && !NONE_MARKERS.has(description.toLowerCase())) {
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        addError(rowNo, `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`);
        group.failed = true;
      } else if (group.description === null) {
        group.description = description;
      }
    }

    if (NONE_MARKERS.has(countriesText.toLowerCase())) {
      group.explicitlyEmpty = true;
    } else {
      const { found, unknown } = resolveCountries(countriesText);
      for (const c of found) group.countries.add(c);
      if (unknown.length > 0) {
        const shown = unknown.slice(0, 5).map((c) => `"${c}"`).join(", ");
        const more = unknown.length > 5 ? ` and ${unknown.length - 5} more` : "";
        addError(rowNo, `Not in Region Data: ${shown}${more}`);
        group.failed = true;
      }
    }
  });

  for (const g of groups.values()) {
    if (g.failed) continue;
    if (unplacedNames.has(g.name.toLowerCase())) {
      g.failed = true;
      addError(g.firstRow, `Set "${g.name}" was skipped because another row naming it has an error`);
    } else if (g.countries.size === 0 && !g.explicitlyEmpty) {
      g.failed = true;
      addError(
        g.firstRow,
        `Set "${g.name}" lists no countries — to empty a set on purpose, put "none" in its Countries cell`
      );
    }
  }

  const valid = [...groups.values()].filter((g) => !g.failed);
  const skippedSets = groups.size - valid.length;

  // Which of the valid sets already exist (case-insensitive, per company)?
  const existing = valid.length
    ? await prisma.countrySet.findMany({
        where: { companyId: { in: [...new Set(valid.map((g) => g.companyId))] } },
        select: { id: true, companyId: true, name: true, description: true, members: { select: { country: true } } },
      })
    : [];
  const keyOf = (companyId: number, name: string) => `${companyId}\u0000${name.toLowerCase()}`;
  const existingByKey = new Map(existing.map((s) => [keyOf(s.companyId, s.name), s]));
  const groupKey = (g: SetGroup) => keyOf(g.companyId, g.name);

  const actionOf = (g: SetGroup): "create" | "update" | "unchanged" => {
    const found = existingByKey.get(groupKey(g));
    if (!found) return "create";
    const current = new Set(found.members.map((m) => m.country));
    const sameCountries = current.size === g.countries.size && [...g.countries].every((c) => current.has(c));
    const sameDescription = g.description === null || g.description === found.description;
    return sameCountries && sameDescription ? "unchanged" : "update";
  };
  const actions = new Map(valid.map((g) => [groupKey(g), actionOf(g)]));
  const count = (a: string) => [...actions.values()].filter((x) => x === a).length;
  const emptied = valid.filter((g) => g.countries.size === 0 && actions.get(groupKey(g)) !== "unchanged").length;

  const preview = valid.map((g) => ({
    company: g.companyName,
    name: g.name,
    countries: g.countries.size,
    action: actions.get(groupKey(g)),
  }));

  const summary = {
    created: count("create"),
    updated: count("update"),
    unchanged: count("unchanged"),
    emptied,
    skippedSets,
    errors,
    errorsTruncated: errors.length >= MAX_ERRORS,
  };

  if (dryRun) {
    return NextResponse.json({ dryRun: true, ...summary, sets: preview.slice(0, 200) });
  }

  const toCreate = valid.filter((g) => actions.get(groupKey(g)) === "create");
  const toUpdate = valid.filter((g) => actions.get(groupKey(g)) === "update");
  const writtenCompanyIds = [...new Set([...toCreate, ...toUpdate].map((g) => g.companyId))];

  if (toCreate.length + toUpdate.length > 0) {
    try {
      // A fixed handful of statements whatever the file size — a per-set loop
      // was ~3 round trips per set inside one transaction, which on a remote
      // database outran the timeout for a large file and rolled it all back.
      await prisma.$transaction(
        async (tx) => {
          const created = toCreate.length
            ? await tx.countrySet.createManyAndReturn({
                data: toCreate.map((g) => ({ companyId: g.companyId, name: g.name, description: g.description })),
                select: { id: true, companyId: true, name: true },
              })
            : [];
          const idByKey = new Map<string, number>(created.map((s) => [keyOf(s.companyId, s.name), s.id]));
          for (const g of toUpdate) idByKey.set(groupKey(g), existingByKey.get(groupKey(g))!.id);

          // Descriptions only where one was supplied and differs — usually few.
          for (const g of toUpdate) {
            const found = existingByKey.get(groupKey(g))!;
            if (g.description !== null && g.description !== found.description) {
              await tx.countrySet.update({ where: { id: found.id }, data: { description: g.description } });
            }
          }

          const updatedIds = toUpdate.map((g) => idByKey.get(groupKey(g))!);
          if (updatedIds.length) {
            await tx.countrySetMember.deleteMany({ where: { countrySetId: { in: updatedIds } } });
          }
          const memberRows = [...toCreate, ...toUpdate].flatMap((g) => {
            const id = idByKey.get(groupKey(g))!;
            return [...g.countries].map((country) => ({ countrySetId: id, country }));
          });
          if (memberRows.length) {
            await tx.countrySetMember.createMany({ data: memberRows, skipDuplicates: true });
          }
        },
        { maxWait: 10_000, timeout: 60_000 }
      );
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      // P2002: a same-named set was created concurrently; P2025: a set this
      // import meant to update was deleted concurrently. Either way the preview
      // no longer describes the database — ask for a retry, never a bare 500.
      if (code === "P2002" || code === "P2025") {
        return NextResponse.json(
          { error: "Country sets changed while importing — preview and import again" },
          { status: 409 }
        );
      }
      console.warn("country-set import failed", err);
      return NextResponse.json({ error: "Import failed" }, { status: 500 });
    }
    invalidateReportCache();
  }

  return NextResponse.json({ ...summary, companyIds: writtenCompanyIds });
}
