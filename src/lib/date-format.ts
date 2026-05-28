export type DateFormat = "DD/MM/YYYY" | "MM/DD/YYYY";

export const DATE_FORMATS: readonly DateFormat[] = ["DD/MM/YYYY", "MM/DD/YYYY"] as const;
export const DEFAULT_DATE_FORMAT: DateFormat = "DD/MM/YYYY";

export function isDateFormat(value: unknown): value is DateFormat {
  return value === "DD/MM/YYYY" || value === "MM/DD/YYYY";
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T|$)/;
const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function coerceDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Format a Date (or ISO/Date-coercible value) in the chosen display format.
 * Date-only values stored at UTC midnight are read with UTC accessors so a
 * 27-May date never displays as 26-May in negative-UTC timezones.
 */
export function formatDateWith(value: Date | string | number | null | undefined, format: DateFormat): string {
  const d = coerceDate(value);
  if (!d) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return format === "DD/MM/YYYY" ? `${dd}/${mm}/${yyyy}` : `${mm}/${dd}/${yyyy}`;
}

/**
 * Date + 24-hour clock for genuine timestamps (last login, audit events).
 * Uses local time because the time-of-day is what the viewer cares about.
 */
export function formatDateTimeWith(value: Date | string | number | null | undefined, format: DateFormat): string {
  const d = coerceDate(value);
  if (!d) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const datePart = format === "DD/MM/YYYY" ? `${dd}/${mm}/${yyyy}` : `${mm}/${dd}/${yyyy}`;
  return `${datePart} ${hh}:${mi}`;
}

/**
 * Strict parse against the declared format. Rejects values where day/month
 * are out of range (e.g. month=15) or where the input doesn't match the
 * declared shape. Always accepts ISO yyyy-mm-dd as a fallback so values from
 * <input type="date"> and API responses continue to round-trip.
 */
export function parseDateWith(input: string, format: DateFormat): Date | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (ISO_DATE_RE.test(trimmed)) {
    const d = new Date(trimmed);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  const m = SLASH_DATE_RE.exec(trimmed);
  if (!m) return null;
  const first = Number(m[1]);
  const second = Number(m[2]);
  const year = Number(m[3]);
  if (!first || !second || !year) return null;

  const day = format === "DD/MM/YYYY" ? first : second;
  const month = format === "DD/MM/YYYY" ? second : first;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1900 || year > 2999) return null;

  // Anchor at UTC midnight so the parsed value round-trips cleanly to the
  // ISO yyyy-mm-dd that the API and <input type="date"> already use.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

export interface FormatDetectionResult {
  format: DateFormat | null;
  ambiguous: boolean;
  conflicts: DateFormat[];
  unparseable: string[];
}

/**
 * Inspect a column of date cells and figure out which format(s) they fit.
 * - If any cell forces one interpretation (day-part > 12 or month-part > 12)
 *   we can name the format with confidence.
 * - If both interpretations work for every cell, we report ambiguous.
 * - If different cells force different formats, we report conflicts.
 * ISO yyyy-mm-dd values are ignored (they're always unambiguous).
 */
export function detectFormat(values: readonly string[]): FormatDetectionResult {
  let fitsDdMm = true;
  let fitsMmDd = true;
  let sawDdOnly = false;
  let sawMmOnly = false;
  const unparseable: string[] = [];

  for (const raw of values) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (ISO_DATE_RE.test(trimmed)) continue;

    const m = SLASH_DATE_RE.exec(trimmed);
    if (!m) {
      unparseable.push(trimmed);
      continue;
    }
    const first = Number(m[1]);
    const second = Number(m[2]);
    if (!first || !second) {
      unparseable.push(trimmed);
      continue;
    }
    const fitsAsDd = first >= 1 && first <= 31 && second >= 1 && second <= 12;
    const fitsAsMm = first >= 1 && first <= 12 && second >= 1 && second <= 31;
    if (!fitsAsDd && !fitsAsMm) {
      unparseable.push(trimmed);
      continue;
    }
    if (!fitsAsDd) sawMmOnly = true;
    if (!fitsAsMm) sawDdOnly = true;
    fitsDdMm = fitsDdMm && fitsAsDd;
    fitsMmDd = fitsMmDd && fitsAsMm;
  }

  if (sawDdOnly && sawMmOnly) {
    return { format: null, ambiguous: false, conflicts: ["DD/MM/YYYY", "MM/DD/YYYY"], unparseable };
  }
  if (sawDdOnly) return { format: "DD/MM/YYYY", ambiguous: false, conflicts: [], unparseable };
  if (sawMmOnly) return { format: "MM/DD/YYYY", ambiguous: false, conflicts: [], unparseable };

  if (fitsDdMm && fitsMmDd) {
    return { format: null, ambiguous: true, conflicts: [], unparseable };
  }
  if (fitsDdMm) return { format: "DD/MM/YYYY", ambiguous: false, conflicts: [], unparseable };
  if (fitsMmDd) return { format: "MM/DD/YYYY", ambiguous: false, conflicts: [], unparseable };

  return { format: null, ambiguous: false, conflicts: [], unparseable };
}

/** Serialise a Date as yyyy-mm-dd (no time, no timezone). */
export function toIsoDate(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Decode an Excel date serial number to ISO yyyy-mm-dd. Excel stores dates as a
 * day count from its epoch; native date cells read with `raw: true` surface as
 * these serials. Gated to a sane modern range (~1954–2119) so an ordinary
 * integer is never mistaken for a date. Honors the workbook's 1904 epoch flag.
 * Returns null when out of range or invalid.
 */
export function excelSerialToIso(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const epochOffset = date1904 ? 24107 : 25569; // days from the Excel epoch to 1970-01-01
  const d = new Date(Math.round((serial - epochOffset) * 86_400 * 1000));
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
