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
 *    untouched.
 *  - **Company per row**, from the Company cell (matched by name,
 *    case-insensitive, among the companies the caller may access) or, when that
 *    cell is blank, the `defaultCompanyId` chosen in the dialog. A company the
 *    caller cannot access is reported with the SAME message as one that does
 *    not exist, so the import cannot be used to discover other tenants' names.
 *  - **All-or-nothing per set.** If any row of a set is invalid (an unknown
 *    country, a bad company), the whole set is skipped and every offending row
 *    reported — importing the valid remainder would overwrite a set with a
 *    silently partial country list.
 *  - Description: written only when the column is mapped and the set's rows
 *    carry a non-blank value; a blank or unmapped description leaves the stored
 *    one alone (an unmapped column writes nothing, as in the other imports).
 */

const MAX_ROWS = 10_000;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_COUNTRY_NAME_LENGTH = 200;
const NULL_MARKERS = new Set(["", "—", "-", "–", "n/a", "none"]);

interface RawRow {
  company?: unknown;
  name?: unknown;
  description?: unknown;
  countries?: unknown;
}

function cell(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function isBlank(v: string): boolean {
  return NULL_MARKERS.has(v.toLowerCase());
}

/** Split a Countries cell on comma, semicolon, pipe or newline. */
function splitCountries(v: string): string[] {
  return v
    .split(/[,;|\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !isBlank(s));
}

interface SetGroup {
  companyId: number;
  companyName: string;
  name: string;
  description: string | null;
  countries: Set<string>;
  rows: number[];
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

  // Companies this caller may write to, by lower-cased name. `null` from
  // getAuthorizedCompanyIds means a SuperAdmin (every company).
  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companies = await prisma.company.findMany({
    where: allowed ? { id: { in: allowed } } : {},
    select: { id: true, name: true },
  });
  const companyByName = new Map(companies.map((c) => [c.name.trim().toLowerCase(), c]));
  const companyById = new Map(companies.map((c) => [c.id, c]));
  if (defaultCompanyId !== null && !companyById.has(defaultCompanyId)) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  // Region Data is the vocabulary of countries; match case-insensitively and
  // store the canonical spelling.
  const regionRows = await prisma.regionData.findMany({ select: { country: true } });
  const canonicalCountry = new Map(regionRows.map((r) => [r.country.trim().toLowerCase(), r.country]));

  const errors: { row: number; message: string }[] = [];
  const groups = new Map<string, SetGroup>();

  rows.forEach((raw: RawRow, i) => {
    const rowNo = i + 1;
    const r: RawRow = raw && typeof raw === "object" ? raw : {};
    const name = cell(r.name);
    const companyCell = cell(r.company);
    const description = cell(r.description);
    const countryNames = splitCountries(cell(r.countries));

    // A row with nothing in it at all (a trailing blank line) is not an error.
    if (!name && !companyCell && !description && countryNames.length === 0) return;

    if (!name || isBlank(name)) {
      errors.push({ row: rowNo, message: "Name is required" });
      return;
    }
    if (name.length > MAX_NAME_LENGTH) {
      errors.push({ row: rowNo, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer` });
      return;
    }

    let company: { id: number; name: string } | undefined;
    if (companyCell && !isBlank(companyCell)) {
      company = companyByName.get(companyCell.toLowerCase());
      if (!company) {
        // Same message whether the company is missing or out of the caller's
        // scope — the response must not confirm another tenant exists.
        errors.push({ row: rowNo, message: `Company "${companyCell}" was not found, or you do not have access to it` });
        return;
      }
    } else if (defaultCompanyId !== null) {
      company = companyById.get(defaultCompanyId);
    }
    if (!company) {
      errors.push({ row: rowNo, message: "Company is required — fill the Company column or choose a default company" });
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
        rows: [],
        failed: false,
      };
      groups.set(key, group);
    }
    group.rows.push(rowNo);

    if (descriptionMapped && description && !isBlank(description)) {
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        errors.push({ row: rowNo, message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` });
        group.failed = true;
      } else if (group.description === null) {
        group.description = description;
      }
    }

    const unknown: string[] = [];
    for (const c of countryNames) {
      if (c.length > MAX_COUNTRY_NAME_LENGTH) {
        unknown.push(`${c.slice(0, 40)}…`);
        continue;
      }
      const canonical = canonicalCountry.get(c.toLowerCase());
      if (canonical) group.countries.add(canonical);
      else unknown.push(c);
    }
    if (unknown.length > 0) {
      const shown = unknown.slice(0, 5).map((c) => `"${c}"`).join(", ");
      const more = unknown.length > 5 ? ` and ${unknown.length - 5} more` : "";
      errors.push({ row: rowNo, message: `Not in Region Data: ${shown}${more}` });
      group.failed = true;
    }
  });

  const valid = [...groups.values()].filter((g) => !g.failed);
  const skippedSets = groups.size - valid.length;

  // Which of the valid sets already exist (case-insensitive, per company)?
  const existing = valid.length
    ? await prisma.countrySet.findMany({
        where: { companyId: { in: [...new Set(valid.map((g) => g.companyId))] } },
        select: { id: true, companyId: true, name: true, description: true, members: { select: { country: true } } },
      })
    : [];
  const existingByKey = new Map(existing.map((s) => [`${s.companyId}\u0000${s.name.toLowerCase()}`, s]));
  const keyOf = (g: SetGroup) => `${g.companyId}\u0000${g.name.toLowerCase()}`;

  // An existing set whose countries (and, when supplied, description) already
  // match the file is reported as unchanged and not rewritten, so the counts
  // say what the import actually did rather than "updated" for every row.
  const actionOf = (g: SetGroup): "create" | "update" | "unchanged" => {
    const found = existingByKey.get(keyOf(g));
    if (!found) return "create";
    const current = new Set(found.members.map((m) => m.country));
    const sameCountries = current.size === g.countries.size && [...g.countries].every((c) => current.has(c));
    const sameDescription = g.description === null || g.description === found.description;
    return sameCountries && sameDescription ? "unchanged" : "update";
  };
  const actions = new Map(valid.map((g) => [keyOf(g), actionOf(g)]));
  const count = (a: string) => [...actions.values()].filter((x) => x === a).length;

  const preview = valid.map((g) => ({
    company: g.companyName,
    name: g.name,
    countries: g.countries.size,
    action: actions.get(keyOf(g)),
  }));

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      created: count("create"),
      updated: count("update"),
      unchanged: count("unchanged"),
      skippedSets,
      errors,
      sets: preview.slice(0, 200),
    });
  }

  const toWrite = valid.filter((g) => actions.get(keyOf(g)) !== "unchanged");
  if (toWrite.length > 0) {
    await prisma.$transaction(
      async (tx) => {
        for (const g of toWrite) {
          const found = existingByKey.get(keyOf(g));
          let setId: number;
          if (found) {
            setId = found.id;
            if (g.description !== null) {
              await tx.countrySet.update({
                where: { id: found.id },
                data: { description: g.description },
              });
            }
            await tx.countrySetMember.deleteMany({ where: { countrySetId: found.id } });
          } else {
            const created = await tx.countrySet.create({
              data: { companyId: g.companyId, name: g.name, description: g.description },
              select: { id: true },
            });
            setId = created.id;
          }
          if (g.countries.size > 0) {
            await tx.countrySetMember.createMany({
              data: [...g.countries].map((country) => ({ countrySetId: setId, country })),
              skipDuplicates: true,
            });
          }
        }
      },
      { maxWait: 10_000, timeout: 60_000 }
    );
    invalidateReportCache();
  }

  return NextResponse.json({
    created: count("create"),
    updated: count("update"),
    unchanged: count("unchanged"),
    skippedSets,
    errors,
  });
}
