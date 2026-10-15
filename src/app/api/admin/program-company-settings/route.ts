import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { readJsonBody } from "@/lib/request-body";
import { invalidateReportCache } from "@/lib/report-cache";
import { isAnchoredProgram } from "@/lib/program-anchor";
import { MINIMUM_COUNTRIES_ERROR, parseMinimumCountries } from "@/lib/program-data-write";

/**
 * Program Partners admin API — a partner's (Company's) own terms for an
 * **anchored** program: the minimum number of target countries it must name
 * (null falls back to `Program.defaultMinimumCountries`) and which of its own
 * Country Sets holds those countries.
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
  minimumCountries: true,
  targetCountrySetId: true,
  program: { select: { name: true, defaultMinimumCountries: true } },
  company: { select: { name: true } },
  targetCountrySet: { select: { name: true, companyId: true } },
} as const;

interface SelectedSetting {
  id: number;
  programId: number;
  companyId: number;
  minimumCountries: number | null;
  targetCountrySetId: number | null;
  program: { name: string; defaultMinimumCountries: number | null } | null;
  company: { name: string } | null;
  targetCountrySet: { name: string; companyId: number } | null;
}

export interface ProgramCompanySettingRow {
  id: number;
  programId: number;
  programName: string;
  companyId: number;
  companyName: string;
  /** This partner's own minimum; null = use the program default. */
  minimumCountries: number | null;
  /** The program default the row falls back to (null = none). */
  defaultMinimumCountries: number | null;
  targetCountrySetId: number | null;
  targetCountrySet: string | null;
}

export interface AnchoredProgramOption {
  id: number;
  name: string;
  anchorTheatre: string;
  defaultMinimumCountries: number | null;
}

export interface ProgramCompanySettingsResponse {
  programs: AnchoredProgramOption[];
  rows: ProgramCompanySettingRow[];
}

/**
 * Build the wire row field by field — an allowlist. The target set is shown
 * only when it belongs to the row's own company (the write path enforces that;
 * this is defence in depth, mirroring `resolvePartnerTerms`).
 */
export function toSettingRow(s: SelectedSetting): ProgramCompanySettingRow {
  const ownSet = s.targetCountrySet && s.targetCountrySet.companyId === s.companyId ? s.targetCountrySet : null;
  return {
    id: s.id,
    programId: s.programId,
    programName: s.program?.name ?? "",
    companyId: s.companyId,
    companyName: s.company?.name ?? "",
    minimumCountries: s.minimumCountries,
    defaultMinimumCountries: s.program?.defaultMinimumCountries ?? null,
    targetCountrySetId: ownSet ? s.targetCountrySetId : null,
    targetCountrySet: ownSet ? ownSet.name : null,
  };
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
 * Resolve a target Country Set id for `companyId`. A set that does not exist
 * and a set owned by another company get the SAME answer, so the endpoint
 * cannot be used to probe other tenants' set ids.
 */
export async function checkTargetSet(
  raw: unknown,
  companyId: number
): Promise<{ ok: true; value: number | null } | { ok: false; error: string }> {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  const id = parsePositiveId(raw);
  if (id === null) return { ok: false, error: "Invalid target country set" };
  const set = await prisma.countrySet.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!set) return { ok: false, error: "Target country set not found for this company" };
  return { ok: true, value: set.id };
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
    const programRows = await prisma.program.findMany({
      where: { anchorTheatre: { not: null } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, anchorTheatre: true, defaultMinimumCountries: true },
    });
    const programs: AnchoredProgramOption[] = programRows
      .filter((p) => isAnchoredProgram(p))
      .map((p) => ({
        id: p.id,
        name: p.name,
        anchorTheatre: p.anchorTheatre!.trim(),
        defaultMinimumCountries: p.defaultMinimumCountries,
      }));

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
    select: { id: true, anchorTheatre: true },
  });
  if (!program) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  if (!isAnchoredProgram(program)) {
    return NextResponse.json(
      { error: "Partner settings apply only to anchored programs — set the program's anchor theatre first" },
      { status: 400 }
    );
  }

  const minimum = parseMinimumCountries(body.minimumCountries);
  if (!minimum.ok) return NextResponse.json({ error: MINIMUM_COUNTRIES_ERROR }, { status: 400 });

  const target = await checkTargetSet(body.targetCountrySetId, companyId);
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: 400 });

  const existing = await prisma.programCompanySetting.findUnique({
    where: { programId_companyId: { programId, companyId } },
    select: { id: true },
  });
  if (existing) return DUPLICATE_SETTING_RESPONSE();

  try {
    const created = await prisma.programCompanySetting.create({
      data: { programId, companyId, minimumCountries: minimum.value, targetCountrySetId: target.value },
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
