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
