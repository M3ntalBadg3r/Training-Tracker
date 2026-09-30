import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { readJsonBody } from "@/lib/request-body";
import { invalidateReportCache } from "@/lib/report-cache";
import type { CountrySetRow } from "@/types";

/**
 * Country Sets admin API — SuperAdmin-only (also gated by `proxy.ts`'s
 * `SUPER_ADMIN_PREFIXES`). A set is global reference data, like RegionData:
 * no company dimension, country names only.
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
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  members: { select: { country: true }, orderBy: { country: "asc" as const } },
} as const;

interface SelectedCountrySet {
  id: number;
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

/** Case-insensitive name clash, so "Set A" and "set a" cannot both exist. */
export async function nameTaken(name: string, exceptId?: number): Promise<boolean> {
  const clash = await prisma.countrySet.findFirst({
    where: {
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
  NextResponse.json({ error: "A country set with that name already exists" }, { status: 409 });

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const [sets, programsUsingLevel] = await Promise.all([
      prisma.countrySet.findMany({ orderBy: { name: "asc" }, select: COUNTRY_SET_SELECT }),
      // The CountrySet requirement level is generic — it applies to whichever
      // set is being viewed — so there is no per-set usage to report. This is
      // the global figure (distinct programs with any Country Set row).
      prisma.programData.findMany({
        where: { level: "CountrySet" },
        distinct: ["programName"],
        select: { programName: true },
      }),
    ]);
    const response: CountrySetListResponse = {
      sets: sets.map((s: SelectedCountrySet) => toCountrySetRow(s)),
      programsUsingCountrySetLevel: programsUsingLevel.length,
    };
    return NextResponse.json(response);
  } catch (err) {
    console.warn("country-sets GET failed", err);
    return NextResponse.json({ error: "Could not load country sets" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const validated = await parseCountrySetBody(parsed.body);
  if (!validated.ok) return validated.response;
  const { name, description, countries } = validated.input;

  if (await nameTaken(name)) return DUPLICATE_NAME_RESPONSE();

  try {
    const created = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const set = await tx.countrySet.create({
        data: { name, description: description ?? null },
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
