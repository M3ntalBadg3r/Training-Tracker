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
