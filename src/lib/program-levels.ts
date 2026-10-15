/**
 * The partner-program geography vocabulary: the stored requirement levels
 * (`ProgramLevel`), how a multi-country level counts a requirement
 * (`ProgramData.aggregation`), and the view scopes the dashboards and
 * Compliance Planning select.
 *
 * **Zero imports, on purpose** — it is read by client components, route
 * handlers, the import and the backup restore alike, and the level lists used
 * to be restated in three admin files plus two write paths. Anything added
 * here must keep it import-free (the same rule as `roles.ts` / `csp.ts`).
 *
 * Scope → requirement level is one-to-one: each view plans and reports against
 * only its own level's requirements. "By Region" used to be derived from the
 * Country-level rows pooled across the region; it now reads Region rows only.
 */

export const REQ_LEVELS = ["Country", "Region", "CountrySet", "Theatre", "Global"] as const;
export type ReqLevel = (typeof REQ_LEVELS)[number];

export const LEVEL_LABELS: Record<ReqLevel, string> = {
  Country: "Country",
  Region: "Region",
  CountrySet: "Country Set",
  Theatre: "Theatre",
  Global: "Global",
};

export function isReqLevel(v: unknown): v is ReqLevel {
  return typeof v === "string" && (REQ_LEVELS as readonly string[]).includes(v);
}

/** A level whose population spans several countries, so it carries a count mode. */
export function isMultiCountryLevel(level: string): level is "Region" | "CountrySet" {
  return level === "Region" || level === "CountrySet";
}

export const AGGREGATIONS = ["total", "eachCountry"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const AGGREGATION_LABELS: Record<Aggregation, string> = {
  total: "Total across the area",
  eachCountry: "In each country",
};

/** Short form for table cells and import/export ("Total" / "Each country"). */
export const AGGREGATION_SHORT_LABELS: Record<Aggregation, string> = {
  total: "Total",
  eachCountry: "Each country",
};

export function isAggregation(v: unknown): v is Aggregation {
  return typeof v === "string" && (AGGREGATIONS as readonly string[]).includes(v);
}

/**
 * The single rule every write and restore path applies: `"eachCountry"` only
 * when the level spans several countries AND the value asks for it; otherwise
 * `"total"`. Two DB CHECK constraints enforce the same thing, so a value that
 * skipped this would fail the write rather than be stored.
 */
export function normaliseAggregation(level: string, raw: unknown): Aggregation {
  return isMultiCountryLevel(level) && raw === "eachCountry" ? "eachCountry" : "total";
}

export const SCOPE_LEVELS = ["global", "theatre", "region", "countrySet", "country"] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

/** Validate a user-editable value (query string, request) — never trust it. */
export function parseScopeLevel(v: string | null | undefined): ScopeLevel | null {
  return typeof v === "string" && (SCOPE_LEVELS as readonly string[]).includes(v) ? (v as ScopeLevel) : null;
}

export const SCOPE_TO_REQ_LEVEL: Record<ScopeLevel, ReqLevel> = {
  global: "Global",
  theatre: "Theatre",
  region: "Region",
  countrySet: "CountrySet",
  country: "Country",
};

export const SCOPE_LEVEL_LABELS: Record<ScopeLevel, string> = {
  global: "Global",
  theatre: "By Theatre",
  region: "By Region",
  countrySet: "By Country Set",
  country: "By Country",
};

/** The noun for a scope's value, for prompts like "Select a country set". */
export const SCOPE_VALUE_NOUN: Record<Exclude<ScopeLevel, "global">, string> = {
  theatre: "theatre",
  region: "region",
  countrySet: "country set",
  country: "country",
};

/** Whether a program whose rows carry `levels` offers the given view scope. */
export function scopeLevelOffered(level: ScopeLevel, levels: readonly string[]): boolean {
  return levels.includes(SCOPE_TO_REQ_LEVEL[level]);
}

/** One country's figure for an "each country" requirement. */
export interface CountryBreakdownRow {
  country: string;
  count: number;
  compliant: boolean;
}

// ---------------------------------------------------------------------------
// Anchored programs (see lib/program-anchor.ts for the server half).
//
// An anchored program (`Program.anchorTheatre` set) is judged over TWO
// populations in ONE view: its Theatre-level rows over the anchor theatre, and
// its CountrySet-level rows over the partner's own target Country Set. Every
// other view reads one level only (SCOPE_TO_REQ_LEVEL is one-to-one), so the
// anchored view is deliberately NOT a member of SCOPE_LEVELS: adding it there
// would break that one-to-one map and every Record keyed on ScopeLevel. Code
// that can show an anchored view uses ProgramViewLevel instead.
// ---------------------------------------------------------------------------

export const ANCHORED_SCOPE = "anchored" as const;
export type ProgramViewLevel = ScopeLevel | typeof ANCHORED_SCOPE;

export const ANCHORED_SCOPE_LABEL = "Target countries";

/** Validate a user-editable view level, anchored included. */
export function parseProgramViewLevel(v: string | null | undefined): ProgramViewLevel | null {
  if (v === ANCHORED_SCOPE) return ANCHORED_SCOPE;
  return parseScopeLevel(v);
}

/** The only requirement levels an anchored program evaluates. */
export const ANCHORED_REQ_LEVELS = ["Theatre", "CountrySet"] as const;
export type AnchoredReqLevel = (typeof ANCHORED_REQ_LEVELS)[number];

export function isAnchoredReqLevel(level: string): level is AnchoredReqLevel {
  return (ANCHORED_REQ_LEVELS as readonly string[]).includes(level);
}

/**
 * Which population an anchored program counts a row over: Theatre rows over the
 * anchor theatre, CountrySet rows over the partner's target countries. `null`
 * for any other level — such rows are not evaluated in an anchored view.
 */
export type AnchoredPopulation = "theatre" | "targetCountries";

export function anchoredPopulationOf(level: string): AnchoredPopulation | null {
  if (level === "Theatre") return "theatre";
  if (level === "CountrySet") return "targetCountries";
  return null;
}

/**
 * A requirement row with neither a specialisation nor a tier is a
 * **program-wide gate**: every tier of a tiered program requires it, in every
 * deployment mode. Only valid on a tiered program (enforced on write).
 */
export function isProgramWideRow(row: {
  specialisationId?: number | null;
  tierId?: number | null;
}): boolean {
  return row.specialisationId == null && row.tierId == null;
}

/** Whose rule supplied a partner's minimum number of target countries. */
export type MinimumCountriesSource = "partner" | "default" | "none";

/**
 * The anchored-view header every surface (dashboard, planning, public API)
 * receives. `targetCountries` are the set's members INSIDE the anchor theatre —
 * the population CountrySet rows are counted over and the only countries that
 * count toward the minimum. `outOfTheatreCountries` are members outside it,
 * listed so the page can warn about them rather than drop them silently.
 */
export interface AnchoredMeta {
  anchorTheatre: string;
  /** The Country Set the view is over; null when the partner has none to show. */
  countrySet: string | null;
  targetCountries: string[];
  outOfTheatreCountries: string[];
  minimumCountries: number | null;
  minimumCountriesSource: MinimumCountriesSource;
  /** `minimumCountries === null || targetCountries.length >= minimumCountries`. */
  minimumMet: boolean;
}
