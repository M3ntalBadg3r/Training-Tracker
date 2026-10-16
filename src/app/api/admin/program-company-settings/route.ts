import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { readJsonBody } from "@/lib/request-body";
import { invalidateReportCache } from "@/lib/report-cache";
import { MAX_MINIMUM_COUNTRIES, parseMinimumCountries } from "@/lib/program-data-write";

/**
 * Program Partners admin API — a partner's (Company's) own terms for a
 * program, one row per (program, company), separately for the two views that
 * carry a minimum number of countries:
 *  - **By Country Set view**: `countrySetMinimumCountries` (null falls back to
 *    `Program.countrySetMinimumCountries`) and `countrySetId`, the partner's
 *    own Country Set the view opens on.
 *  - **By Theatre view**: `targetMinimumCountries` (null falls back to
 *    `Program.targetMinimumCountries`) and `targetCountrySetId`, the partner's
 *    own Country Set listing its target countries.
 * Any program may carry partner rows.
 *
 * **Company-scoped, Admin-accessible** — the same arrangement as
 * `/api/admin/country-sets`: a company Admin manages their own companies'
 * rows, a SuperAdmin all of them. The path is deliberately NOT in `proxy.ts`'s
 * `SUPER_ADMIN_PREFIXES` (it does not start with `/api/admin/program-data/`),
 * the proxy's general admin gate still refuses a read-only `User`, and every
 * handler here re-checks `requireAuth("Admin")` and the company scope itself.
 * Programs are a global registry, so the program list in the GET is unscoped;
 * the rows are tenant data and always scoped.
 *
 * The serializer and body helpers are exported for `[id]/route.ts` and
 * `import/route.ts`.
 */

export const PROGRAM_COMPANY_SETTING_SELECT = {
  id: true,
  programId: true,
  companyId: true,
  countrySetMinimumCountries: true,
  countrySetId: true,
  targetMinimumCountries: true,
  targetCountrySetId: true,
  program: { select: { name: true, countrySetMinimumCountries: true, targetMinimumCountries: true } },
  company: { select: { name: true } },
  countrySet: { select: { name: true, companyId: true } },
  targetCountrySet: { select: { name: true, companyId: true } },
} as const;

interface SelectedSetting {
  id: number;
  programId: number;
  companyId: number;
  countrySetMinimumCountries: number | null;
  countrySetId: number | null;
  targetMinimumCountries: number | null;
  targetCountrySetId: number | null;
  program: { name: string; countrySetMinimumCountries: number | null; targetMinimumCountries: number | null } | null;
  company: { name: string } | null;
  countrySet: { name: string; companyId: number } | null;
  targetCountrySet: { name: string; companyId: number } | null;
}

export interface ProgramCompanySettingRow {
  id: number;
  programId: number;
  programName: string;
  companyId: number;
  companyName: string;
  /** By Country Set view: this partner's own minimum; null = use the program default. */
  countrySetMinimumCountries: number | null;
  /** The program's By Country Set default the row falls back to (null = none). */
  defaultCountrySetMinimumCountries: number | null;
  countrySetId: number | null;
  countrySet: string | null;
  /** By Theatre view: this partner's own minimum target countries; null = use the program default. */
  targetMinimumCountries: number | null;
  /** The program's By Theatre default the row falls back to (null = none). */
  defaultTargetMinimumCountries: number | null;
  targetCountrySetId: number | null;
  targetCountrySet: string | null;
}

export interface ProgramOption {
  id: number;
  name: string;
  countrySetMinimumCountries: number | null;
  targetMinimumCountries: number | null;
}

export interface ProgramCompanySettingsResponse {
  programs: ProgramOption[];
  rows: ProgramCompanySettingRow[];
}

/**
 * Build the wire row field by field — an allowlist. Each set is shown only
 * when it belongs to the row's own company (the write path enforces that; this
 * is defence in depth, mirroring `resolvePartnerTerms`).
 */
export function toSettingRow(s: SelectedSetting): ProgramCompanySettingRow {
  const own = (set: { name: string; companyId: number } | null) => (set && set.companyId === s.companyId ? set : null);
  const csSet = own(s.countrySet);
  const targetSet = own(s.targetCountrySet);
  return {
    id: s.id,
    programId: s.programId,
    programName: s.program?.name ?? "",
    companyId: s.companyId,
    companyName: s.company?.name ?? "",
    countrySetMinimumCountries: s.countrySetMinimumCountries,
    defaultCountrySetMinimumCountries: s.program?.countrySetMinimumCountries ?? null,
    countrySetId: csSet ? s.countrySetId : null,
    countrySet: csSet ? csSet.name : null,
    targetMinimumCountries: s.targetMinimumCountries,
    defaultTargetMinimumCountries: s.program?.targetMinimumCountries ?? null,
    targetCountrySetId: targetSet ? s.targetCountrySetId : null,
    targetCountrySet: targetSet ? targetSet.name : null,
  };
}

/** The four writable fields, and the label each is known by in messages. */
export const SETTING_FIELDS = {
  countrySetMinimumCountries: "Country Set view minimum",
  countrySetId: "Country Set",
  targetMinimumCountries: "Theatre view minimum",
  targetCountrySetId: "Target country set",
} as const;

export function minimumError(field: "countrySetMinimumCountries" | "targetMinimumCountries"): string {
  return `${SETTING_FIELDS[field]} must be a whole number from 1 to ${MAX_MINIMUM_COUNTRIES}, or blank`;
}

/**
 * A positive integer id from an untrusted value — a JSON number or a
 * digit-only string (a `<select>` value). Anything else (blank, fractional,
 * negative, "1e3") is rejected rather than coerced, so `Number("")` can never
 * become id 0. The same rule as the country-sets `parseCompanyId`.
 */
export function parsePositiveId(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Resolve a Country Set id for `companyId` (either view's set). A set that does
 * not exist and a set owned by another company get the SAME answer, so the
 * endpoint cannot be used to probe other tenants' set ids.
 */
export async function checkCompanySet(
  raw: unknown,
  companyId: number,
  field: "countrySetId" | "targetCountrySetId"
): Promise<{ ok: true; value: number | null } | { ok: false; error: string }> {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  const label = SETTING_FIELDS[field];
  const id = parsePositiveId(raw);
  if (id === null) return { ok: false, error: `Invalid ${label.toLowerCase()}` };
  const set = await prisma.countrySet.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!set) return { ok: false, error: `${label} not found for this company` };
  return { ok: true, value: set.id };
}

type SettingData = {
  countrySetMinimumCountries?: number | null;
  countrySetId?: number | null;
  targetMinimumCountries?: number | null;
  targetCountrySetId?: number | null;
};

/**
 * Read the four writable fields from a POST/PUT body. Each key is tri-state:
 * absent = left out of the result (leave alone); `null`/`""` = clear;
 * otherwise validated — a minimum strictly (1–1000), a set against
 * `companyId`.
 */
export async function parseSettingBody(
  body: Record<string, unknown>,
  companyId: number
): Promise<{ ok: true; value: SettingData } | { ok: false; error: string }> {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const data: SettingData = {};
  for (const field of ["countrySetMinimumCountries", "targetMinimumCountries"] as const) {
    if (!has(field)) continue;
    const minimum = parseMinimumCountries(body[field]);
    if (!minimum.ok) return { ok: false, error: minimumError(field) };
    data[field] = minimum.value;
  }
  for (const field of ["countrySetId", "targetCountrySetId"] as const) {
    if (!has(field)) continue;
    const set = await checkCompanySet(body[field], companyId, field);
    if (!set.ok) return set;
    data[field] = set.value;
  }
  return { ok: true, value: data };
}

export const DUPLICATE_SETTING_RESPONSE = () =>
  NextResponse.json(
    { error: "This company already has settings for this program — edit the existing row" },
    { status: 409 }
  );

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const programs: ProgramOption[] = await prisma.program.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, countrySetMinimumCountries: true, targetMinimumCountries: true },
    });

    const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
    const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));
    // `[]` = no companies in scope (or one outside the grant): answer no rows,
    // never an unfiltered list.
    if (companyFilter !== null && companyFilter.length === 0) {
      const empty: ProgramCompanySettingsResponse = { programs, rows: [] };
      return NextResponse.json(empty);
    }

    const rows = await prisma.programCompanySetting.findMany({
      where: companyFilter ? { companyId: { in: companyFilter } } : {},
      orderBy: [{ programId: "asc" }, { companyId: "asc" }],
      select: PROGRAM_COMPANY_SETTING_SELECT,
    });
    const response: ProgramCompanySettingsResponse = {
      programs,
      rows: rows.map((r: SelectedSetting) => toSettingRow(r)),
    };
    return NextResponse.json(response);
  } catch (err) {
    console.warn("program-company-settings GET failed", err);
    return NextResponse.json({ error: "Could not load program partner settings" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const parsed = await readJsonBody(request, 64 * 1024);
  if (!parsed.ok) return parsed.response;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const body = parsed.body as Record<string, unknown>;

  // The company is checked against the caller's grant before anything else is
  // looked up (the /api/admin/country-sets POST order).
  const companyId = parsePositiveId(body.companyId);
  if (companyId === null) {
    return NextResponse.json({ error: "A company is required" }, { status: 400 });
  }
  if (!(await canAccessCompany(auth.sub, auth.role, companyId))) {
    return NextResponse.json({ error: "You do not have access to that company" }, { status: 403 });
  }
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  const programId = parsePositiveId(body.programId);
  if (programId === null) {
    return NextResponse.json({ error: "A program is required" }, { status: 400 });
  }
  const program = await prisma.program.findUnique({
    where: { id: programId },
    select: { id: true },
  });
  if (!program) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }

  const fields = await parseSettingBody(body, companyId);
  if (!fields.ok) return NextResponse.json({ error: fields.error }, { status: 400 });

  const existing = await prisma.programCompanySetting.findUnique({
    where: { programId_companyId: { programId, companyId } },
    select: { id: true },
  });
  if (existing) return DUPLICATE_SETTING_RESPONSE();

  try {
    const created = await prisma.programCompanySetting.create({
      data: { programId, companyId, ...fields.value },
      select: PROGRAM_COMPANY_SETTING_SELECT,
    });
    invalidateReportCache();
    return NextResponse.json(toSettingRow(created), { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_SETTING_RESPONSE();
    console.warn("program-company-settings POST failed", err);
    return NextResponse.json({ error: "Could not save the partner settings" }, { status: 500 });
  }
}
