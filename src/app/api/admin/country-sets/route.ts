import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { readJsonBody } from "@/lib/request-body";
import { invalidateReportCache } from "@/lib/report-cache";
import type { CountrySetRow } from "@/types";

/**
 * Country Sets admin API — **company-scoped**, Admin-accessible (the same
 * arrangement as `/api/admin/offerings`). A set is tenant data: it belongs to
 * exactly one Company and its name is unique only within that company. A
 * company Admin manages the sets of the companies they hold; a SuperAdmin
 * manages all of them. The path is deliberately NOT in `proxy.ts`'s
 * `SUPER_ADMIN_PREFIXES`; the proxy's general admin gate still refuses a
 * read-only `User`, and every handler here re-checks `requireAuth("Admin")`
 * and the company scope itself.
 *
 * The body parser and the row serializer are exported so `[id]/route.ts`
 * shares them rather than carrying a second copy that could drift (the same
 * arrangement as `api/admin/backup/route.ts` and its sub-routes).
 */

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_COUNTRIES = 5000;
const MAX_COUNTRY_NAME_LENGTH = 200;

/** Every list/detail read selects exactly this, so the serializer sees one shape. */
export const COUNTRY_SET_SELECT = {
  id: true,
  companyId: true,
  company: { select: { name: true } },
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  members: { select: { country: true }, orderBy: { country: "asc" as const } },
} as const;

interface SelectedCountrySet {
  id: number;
  companyId: number;
  company: { name: string } | null;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  members: { country: string }[];
}

/**
 * Build the wire row field by field — an allowlist, so a column added to the
 * model later is inert here until someone deliberately emits it.
 */
export function toCountrySetRow(s: SelectedCountrySet): CountrySetRow {
  return {
    id: s.id,
    companyId: s.companyId,
    companyName: s.company?.name ?? "",
    name: s.name,
    description: s.description,
    countries: s.members.map((m) => m.country).sort((a, b) => a.localeCompare(b)),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export interface CountrySetInput {
  name: string;
  /** `undefined` (partial mode only) = key absent, leave the stored value alone. */
  description: string | null | undefined;
  /** `undefined` (partial mode only) = key absent, keep the current members. */
  countries: string[] | undefined;
}

/** GET response: the sets plus the global Country Set level usage. */
export interface CountrySetListResponse {
  sets: CountrySetRow[];
  /**
   * Distinct programs with any Country Set requirement. The level is generic —
   * it applies to whichever set is viewed — so this is not per-set usage.
   * Programs are a global registry, so this figure is not company-scoped.
   */
  programsUsingCountrySetLevel: number;
}

/**
 * Validate `{ name, description?, countries }`. Returns the normalised input or
 * a ready 400. Countries are trimmed and de-duplicated; every one must exist in
 * RegionData (the member FK would reject it anyway — this turns that into a
 * readable 400 naming the country, which is safe because region data is
 * global reference data). An empty country list is allowed.
 *
 * `partial` (PUT): an absent `description` / `countries` key parses to
 * `undefined`, meaning "leave it alone" — only an explicit `null`/`""` clears
 * the description and only an explicit `[]` clears the members. `name` is
 * required either way. POST (not partial) treats absent as empty.
 *
 * `companyId` is not parsed here: POST reads it separately (it must be
 * scope-checked before anything else), and PUT never accepts a change to it.
 */
export async function parseCountrySetBody(
  body: unknown,
  { partial = false }: { partial?: boolean } = {}
): Promise<{ ok: true; input: CountrySetInput } | { ok: false; response: NextResponse }> {
  const bad = (error: string) => ({
    ok: false as const,
    response: NextResponse.json({ error }, { status: 400 }),
  });

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return bad("Invalid request body");
  }
  const b = body as Record<string, unknown>;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return bad("Name is required");
  if (name.length > MAX_NAME_LENGTH) {
    return bad(`Name must be at most ${MAX_NAME_LENGTH} characters`);
  }

  const has = (key: string) => Object.prototype.hasOwnProperty.call(b, key);

  let description: string | null | undefined = partial && !has("description") ? undefined : null;
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string") return bad("Description must be text");
    const trimmed = b.description.trim();
    if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
      return bad(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
    }
    description = trimmed || null;
  }

  if (partial && !has("countries")) {
    return { ok: true, input: { name, description, countries: undefined } };
  }
  const rawCountries = b.countries ?? [];
  if (!Array.isArray(rawCountries) || rawCountries.some((c) => typeof c !== "string")) {
    return bad("Countries must be a list of country names");
  }
  if (rawCountries.length > MAX_COUNTRIES) return bad("Too many countries");
  const countries = [
    ...new Set((rawCountries as string[]).map((c) => c.trim()).filter(Boolean)),
  ];
  if (countries.some((c) => c.length > MAX_COUNTRY_NAME_LENGTH)) {
    return bad(`Country names must be at most ${MAX_COUNTRY_NAME_LENGTH} characters`);
  }

  if (countries.length > 0) {
    const known = await prisma.regionData.findMany({
      where: { country: { in: countries } },
      select: { country: true },
    });
    const knownSet = new Set(known.map((r: { country: string }) => r.country));
    const unknown = countries.filter((c) => !knownSet.has(c));
    if (unknown.length > 0) {
      const shown = unknown.slice(0, 5).map((c) => `"${c}"`).join(", ");
      const more = unknown.length > 5 ? ` and ${unknown.length - 5} more` : "";
      return bad(`Not in Region Data: ${shown}${more}`);
    }
  }

  return { ok: true, input: { name, description, countries } };
}

/**
 * A positive integer company id from an untrusted value, else null. Accepts a
 * JSON number or a digit-only string (a `<select>` value); anything else —
 * missing, blank, fractional, negative, `"1e3"` — is rejected rather than
 * coerced, so `Number("")` can never become company 0.
 */
export function parseCompanyId(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Case-insensitive name clash **within one company**, so "Set A" and "set a"
 * cannot both exist for the same company — while two companies may each own a
 * "Set A" holding different countries.
 */
export async function nameTaken(companyId: number, name: string, exceptId?: number): Promise<boolean> {
  const clash = await prisma.countrySet.findFirst({
    where: {
      companyId,
      name: { equals: name, mode: "insensitive" },
      ...(exceptId !== undefined ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });
  return clash !== null;
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export const DUPLICATE_NAME_RESPONSE = () =>
  NextResponse.json(
    { error: "A country set with that name already exists for this company" },
    { status: 409 }
  );

/** Distinct programs with any Country Set row — programs are global, not tenant data. */
async function countProgramsUsingCountrySetLevel(): Promise<number> {
  // The CountrySet requirement level is generic — it applies to whichever
  // set is being viewed — so there is no per-set usage to report. This is
  // the global figure (distinct programs with any Country Set row).
  const rows = await prisma.programData.findMany({
    where: { level: "CountrySet" },
    distinct: ["programName"],
    select: { programName: true },
  });
  return rows.length;
}

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
    const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));
    // `[]` = a scoped caller with no companies, or one asking for a company
    // outside their grant: answer nothing rather than drop the filter.
    if (companyFilter !== null && companyFilter.length === 0) {
      const empty: CountrySetListResponse = {
        sets: [],
        programsUsingCountrySetLevel: await countProgramsUsingCountrySetLevel(),
      };
      return NextResponse.json(empty);
    }

    const [sets, programsUsingLevel] = await Promise.all([
      prisma.countrySet.findMany({
        where: companyFilter ? { companyId: { in: companyFilter } } : {},
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: COUNTRY_SET_SELECT,
      }),
      countProgramsUsingCountrySetLevel(),
    ]);
    const response: CountrySetListResponse = {
      sets: sets.map((s: SelectedCountrySet) => toCountrySetRow(s)),
      programsUsingCountrySetLevel: programsUsingLevel,
    };
    return NextResponse.json(response);
  } catch (err) {
    console.warn("country-sets GET failed", err);
    return NextResponse.json({ error: "Could not load country sets" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  // The owning company comes from the body and is checked against the
  // caller's grant before anything else is looked up.
  const rawCompanyId =
    parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body)
      ? (parsed.body as Record<string, unknown>).companyId
      : undefined;
  const companyId = parseCompanyId(rawCompanyId);
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

  const validated = await parseCountrySetBody(parsed.body);
  if (!validated.ok) return validated.response;
  const { name, description, countries } = validated.input;

  if (await nameTaken(companyId, name)) return DUPLICATE_NAME_RESPONSE();

  try {
    const created = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const set = await tx.countrySet.create({
        data: { companyId, name, description: description ?? null },
        select: { id: true },
      });
      if (countries && countries.length > 0) {
        await tx.countrySetMember.createMany({
          data: countries.map((country) => ({ countrySetId: set.id, country })),
        });
      }
      return tx.countrySet.findUniqueOrThrow({
        where: { id: set.id },
        select: COUNTRY_SET_SELECT,
      });
    });
    invalidateReportCache();
    return NextResponse.json(toCountrySetRow(created), { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME_RESPONSE();
    console.warn("country-sets POST failed", err);
    return NextResponse.json({ error: "Could not create the country set" }, { status: 500 });
  }
}
