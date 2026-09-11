/**
 * Decode a URL-encoded path segment safely. decodeURIComponent throws on
 * malformed sequences (e.g. lone `%`); we'd rather surface a 400 to the
 * caller than a 500 stack trace.
 */
export function safeDecodeParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

export function computeExpiryDate(completedDate: Date): Date {
  return addYears(completedDate, 2);
}

export function isActive(expiryDate: Date): boolean {
  return new Date(expiryDate) >= new Date();
}

// Date display formatting now lives in src/lib/date-format.ts. Server-side
// code should call `formatDateWith` with the result of `getSystemDateFormat()`;
// client code should call the `useDateFormat()` hook for per-user preference.

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict ISO yyyy-mm-dd parser. Used for dates submitted from the in-app
 * date picker (which always emits ISO) and the manual training-taken API.
 * The CSV import flow uses `parseDateWith` from lib/date-format with an
 * explicit format hint — this function intentionally rejects everything else
 * so that ambiguous slash dates can't slip into the DB undetected.
 */
export function parseDate(dateStr: string): Date | null {
  if (!ISO_DATE_ONLY_RE.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date;
}

export function trainingTypeLabel(value: string): string {
  const map: Record<string, string> = {
    Certification: "Certification",
    Accreditation: "Accreditation",
    InstructorLedTraining: "Instructor-Led Training",
    OLX: "OLX",
    OLXSubItem: "OLX Sub-Item",
  };
  return map[value] || value;
}

export function functionTypeLabel(value: string): string {
  const map: Record<string, string> = {
    Sales: "Sales",
    PreSales: "Pre-Sales",
    Deployments: "Deployments",
  };
  return map[value] || value;
}

// ─── Person-name helpers ─────────────────────────────────────────────────────
// Shared by the Data Clean-Up scanner (api/admin/cleanup) and the student import
// (api/import), which each carried their own diverging copy until they disagreed
// about what a clean name looks like.

/**
 * Characters permitted in a person's name: letters of any script, combining
 * marks, spaces, hyphens, apostrophes.
 *
 * `\p{M}` is deliberate — Devanagari matras, NFD-decomposed accents and Arabic
 * pointing are combining marks, and stripping them corrupts the name beyond
 * recovery.
 *
 * INVARIANT: this must stay in lockstep with SPECIAL_CHARS_REGEX and the name
 * pipeline in api/admin/cleanup/route.ts, and with the highlighter regex in
 * admin/cleanup/page.tsx. If the clean-up scanner rejects a character these
 * helpers can emit, its own "suggested fix" gets re-flagged on the next scan —
 * which is exactly how they drifted apart before.
 */
const NAME_DISALLOWED = /[^\p{L}\p{M}\s\-']/gu;

/**
 * Title-case a person's name: capitalise the first letter of each word and of
 * anything following a hyphen or apostrophe, lowercase the rest, collapse
 * whitespace runs, trim. So `o'brien` → `O'Brien`, `anne-marie` → `Anne-Marie`.
 *
 * Deliberately does NOT strip digits: an explicitly-supplied name must reach the
 * clean-up scanner intact so it can be flagged rather than silently altered.
 *
 * Known limitation (pre-existing, shared by both replaced copies): `McDonald`
 * lowercases to `Mcdonald`. A Mc/Mac heuristic misfires on real names such as
 * `Macey`, so callers avoid re-casing a name that isn't uniformly cased.
 */
export function titleCaseName(str: string): string {
  return str
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * Best-effort human name from an email's local part.
 *
 * `.` and `_` are the conventional separators. A hyphen is usually *inside* a
 * double-barrelled name (`anne-marie.dubois`), so it is preserved — unless it is
 * the only separator present (`john-smith`), in which case it is doing that job.
 * A single fixed rule gets one of those two wrong.
 *
 * The result contains no digits and nothing outside NAME_DISALLOWED's allowed
 * set, so callers can use it directly without re-sanitising. Returns "" when the
 * local part holds no letters at all.
 */
export function deriveNameFromEmail(email: string): string {
  // Drop plus-addressing: `jane.doe+hr@` is Jane Doe, not Jane Doehr.
  const local = (email.split("@")[0] ?? "").split("+")[0];

  let parts = local.split(/[._]+/).filter(Boolean);
  if (parts.length < 2) parts = local.split(/[-._]+/).filter(Boolean);

  const words = parts
    .map((p) => p.replace(/[0-9]/g, "").replace(NAME_DISALLOWED, ""))
    .filter((p) => /\p{L}/u.test(p));

  return titleCaseName(words.join(" "));
}

/**
 * Schemes permitted in a stored link field (TrainingData.link, Offering.link).
 *
 * These are free text — typed by an Admin, or lifted from a spreadsheet column
 * by the bulk importers — and they go straight into an `<a href>`. React's
 * escaping applies to attribute *values*, not to the URL *scheme*, so the thing
 * that makes every other user-supplied string safe does not cover this field.
 *
 * ── What this is, and what it is NOT ─────────────────────────────────────────
 * This is defence in depth, NOT a fix for a live vulnerability. That distinction
 * was established by experiment rather than assumed, and it is worth recording
 * because the code reads like the opposite. Driving a real Chromium against a
 * planted row:
 *
 *   - `javascript:` never reaches the DOM. React 19 substitutes its own
 *     throwing URL, so the rendered href was React's blocking message and the
 *     payload did not run.
 *   - `data:text/html,…` DOES reach the DOM verbatim — React blocks only
 *     `javascript:` — but clicking it navigated nowhere: the browser refuses
 *     top-level navigation to a `data:` URL.
 *   - `vbscript:` reaches the DOM verbatim and is inert outside old IE.
 *
 * So two unrelated protections, in two different layers, are what currently
 * stand between a stored link and script execution — and neither is visible at
 * the call site. The allowlist below is worth having anyway for the reasons in
 * `safeExternalUrl`, but do not describe it as closing an XSS hole: it is not,
 * and a release note that says so would be wrong.
 */
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Normalise a stored link to one that is safe to put in an `href`, or null.
 *
 * Returns the trimmed input unchanged when it is an absolute http(s) URL, and
 * null for everything else — a dangerous scheme, a relative path, a blank, or
 * anything the URL parser rejects. The input is returned rather than
 * `url.href` so a saved link is displayed as the Admin typed it, instead of
 * being silently re-normalised (a trailing slash appearing after a save reads
 * as data loss to the person who typed it).
 *
 * Parsing with `URL` rather than a regex is deliberate: it applies the WHATWG
 * rules that browsers apply when they follow the link, so the obfuscations a
 * hand-rolled prefix check misses — embedded tabs and newlines inside the
 * scheme (`java&#9;script:`), mixed case, leading control characters — are
 * resolved the same way here as in the address bar, and then compared against
 * the allowlist.
 *
 * Applied at BOTH ends, deliberately. Validating only on write leaves rows
 * already in the database live; sanitising only on render leaves the API (and
 * the public API, which serves `Offering.link`) handing the raw value to every
 * other consumer.
 */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Relative or unparseable. These fields are for external resources, so a
    // value that isn't an absolute URL is a mistake either way.
    return null;
  }

  return ALLOWED_LINK_PROTOCOLS.has(parsed.protocol) ? trimmed : null;
}

/**
 * True when `value` is non-blank but not an acceptable link. Lets a write path
 * tell "the Admin left it empty" (fine — the column is nullable) apart from
 * "the Admin supplied something we refuse to store", so only the second is an
 * error. Both collapse to null through `safeExternalUrl` alone.
 */
export function isRejectedLink(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "" && safeExternalUrl(value) === null;
}
