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
 * Each view plans and reports against only its own levels' requirements.
 * Every view reads exactly one level except **By Theatre**, which reads its
 * Theatre rows over the theatre AND its TargetCountries rows over the partner's
 * target countries inside that theatre (`SCOPE_REQ_LEVELS`). "By Region" used to
 * be derived from the Country-level rows pooled across the region; it now reads
 * Region rows only.
 */

export const REQ_LEVELS = ["Country", "Region", "CountrySet", "TargetCountries", "Theatre", "Global"] as const;
export type ReqLevel = (typeof REQ_LEVELS)[number];

export const LEVEL_LABELS: Record<ReqLevel, string> = {
  Country: "Country",
  Region: "Region",
  CountrySet: "Country Set",
  TargetCountries: "Target countries",
  Theatre: "Theatre",
  Global: "Global",
};

export function isReqLevel(v: unknown): v is ReqLevel {
  return typeof v === "string" && (REQ_LEVELS as readonly string[]).includes(v);
}

/** A level whose population spans several countries, so it carries a count mode. */
export function isMultiCountryLevel(level: string): level is "Region" | "CountrySet" | "TargetCountries" {
  return level === "Region" || level === "CountrySet" || level === "TargetCountries";
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

/**
 * A view's **primary** requirement level. One-to-one, so it stays usable as a
 * label/lookup key; the full set of levels a view evaluates is
 * `SCOPE_REQ_LEVELS` (only By Theatre reads two).
 */
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

/** Every requirement level a view evaluates. */
export const SCOPE_REQ_LEVELS: Record<ScopeLevel, readonly ReqLevel[]> = {
  global: ["Global"],
  theatre: ["Theatre", "TargetCountries"],
  region: ["Region"],
  countrySet: ["CountrySet"],
  country: ["Country"],
};

/** Whether a program whose rows carry `levels` offers the given view scope. */
export function scopeLevelOffered(level: ScopeLevel, levels: readonly string[]): boolean {
  return SCOPE_REQ_LEVELS[level].some((l) => levels.includes(l));
}

/** One country's figure for an "each country" requirement. */
export interface CountryBreakdownRow {
  country: string;
  count: number;
  compliant: boolean;
}

// ---------------------------------------------------------------------------
// Target countries and per-view minimums (see lib/program-target-countries.ts
// for the server half).
//
// A program's By Theatre view evaluates TWO populations together: its Theatre
// rows over the viewed theatre, and its TargetCountries rows over the partner's
// target countries — the members of the partner's Theatre-view Country Set
// that lie inside that theatre. Its By Country Set view checks how many
// countries the viewed set holds against a minimum. Both minimums are per view
// and per partner (ProgramCompanySetting), falling back to the program default.
// ---------------------------------------------------------------------------

/**
 * Which population a By Theatre view counts a row over: Theatre rows over the
 * theatre, TargetCountries rows over the partner's target countries in it.
 * `null` for any other level — such rows are not part of a Theatre view.
 */
export type PopulationKind = "theatre" | "targetCountries";

export function theatreViewPopulationOf(level: string): PopulationKind | null {
  if (level === "Theatre") return "theatre";
  if (level === "TargetCountries") return "targetCountries";
  return null;
}

/**
 * The `populationLabel` of a target-countries population when the partner has
 * no target set to name. Display helpers recognise it so a row reads "Counted
 * over target countries (no target set configured)" rather than repeating the
 * population kind as if it were a set's name.
 */
export const NO_TARGET_SET_LABEL = "no target set configured";

/** Validate a user-editable population value (roster `?population=`). */
export function parsePopulationKind(v: string | null | undefined): PopulationKind | null {
  return v === "theatre" || v === "targetCountries" ? v : null;
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

/** Whose rule supplied a minimum number of countries. */
export type MinimumCountriesSource = "partner" | "default" | "none";

/** The two views that carry a minimum number of countries. */
export type MinimumView = "countrySet" | "theatre";

/**
 * The target-countries header of a By Theatre view of a program that has
 * TargetCountries rows. `targetCountries` are the set's members INSIDE the
 * viewed theatre — the population TargetCountries rows are counted over and
 * the only countries that count toward the minimum. `outOfTheatreCountries`
 * are members outside it, listed so the page can say so rather than drop them
 * silently.
 */
export interface TargetCountriesMeta {
  theatre: string;
  /** The Country Set the targets come from; null when the partner has none to show. */
  countrySet: string | null;
  targetCountries: string[];
  outOfTheatreCountries: string[];
  minimumCountries: number | null;
  minimumCountriesSource: MinimumCountriesSource;
  /** `minimumCountries === null || targetCountries.length >= minimumCountries`. */
  minimumMet: boolean;
}

/** The minimum-countries header of a By Country Set view. */
export interface CountrySetMinimumMeta {
  /** The Country Set the view is over; null when none is chosen or configured. */
  countrySet: string | null;
  countries: string[];
  minimumCountries: number | null;
  minimumCountriesSource: MinimumCountriesSource;
  /** `minimumCountries === null || countries.length >= minimumCountries`. */
  minimumMet: boolean;
}

/** The wire shape of a minimum-countries gate on a tier block. */
export interface MinimumCountriesGate {
  /** Which view's minimum this is. */
  view: MinimumView;
  /** The effective minimum (null = no minimum applies, and the gate is met). */
  required: number | null;
  /** Countries counted: the set's members (Country Set view) or the target countries inside the theatre (Theatre view). */
  counted: number;
  met: boolean;
  /** Whose rule the minimum came from: the partner's own, the program default, or none. */
  source: MinimumCountriesSource;
}
