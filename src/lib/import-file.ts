/**
 * Client-side guard applied before a chosen spreadsheet is handed to
 * `XLSX.read` / `Papa.parse`.
 *
 * Eight admin pages hand-roll the same `FileReader` → `Uint8Array` → `XLSX.read`
 * sequence, and none of them bounded the input. Two things were missing and
 * both are cheap:
 *
 *  1. **No size cap.** `readAsArrayBuffer` buffers the whole file, then SheetJS
 *     materialises a parsed workbook on top of it — and an `.xlsx` is a ZIP
 *     container, so a small file can expand a long way. The victim is the
 *     admin's own browser tab, so the realistic outcome is a hang rather than a
 *     server-side compromise; it is still a hang they cannot diagnose, caused by
 *     a file somebody sent them.
 *  2. **Type decided by filename alone.** Each caller switches on
 *     `file.name.split(".").pop()`, so `payload.bin` renamed to `payload.xlsx`
 *     is routed straight into the parser. The `accept=` attribute on the input
 *     is a file-picker filter, not a control — drag-and-drop and "All files"
 *     both bypass it.
 *
 * This is deliberately a *guard* rather than a shared reader: the eight parsers
 * genuinely differ (header rows, `raw` handling, the 1904 epoch flag), and
 * replacing them wholesale would risk far more than it fixes. Each caller keeps
 * its own parsing and just refuses the file first.
 */

/** Default 25 MB. Comfortably above a real catalogue export, far below a bomb. */
export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;

export const ACCEPTED_IMPORT_EXTENSIONS = ["csv", "xls", "xlsx"] as const;

export type ImportExtension = (typeof ACCEPTED_IMPORT_EXTENSIONS)[number];

function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Returns an error message to show the user, or null when the file may be
 * parsed. Callers already have an error-setting path for a malformed file, so
 * they surface this the same way.
 */
export function checkImportFile(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(ACCEPTED_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    return `Unsupported file type ".${ext}". Choose a CSV or Excel file (${ACCEPTED_IMPORT_EXTENSIONS.map((e) => `.${e}`).join(", ")}).`;
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return `That file is ${formatMb(file.size)}, which is over the ${formatMb(MAX_IMPORT_FILE_BYTES)} import limit. Split it into smaller files and import them one at a time.`;
  }
  if (file.size === 0) {
    return "That file is empty.";
  }
  return null;
}
