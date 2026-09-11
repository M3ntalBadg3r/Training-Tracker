/**
 * CSV cell neutralisation, shared by every path that writes a CSV.
 *
 * A spreadsheet treats a field beginning `=`, `+`, `-`, `@`, TAB or CR as a
 * formula when it imports a CSV, so a value that merely *passed through* this
 * application — an imported training title, an offering name, a link — becomes
 * executable in the reader's spreadsheet. `Papa.unparse` quotes for CSV
 * correctness, which is a different problem; quoting does not stop evaluation.
 *
 * This matters here more than in a typical app because of the **scheduled**
 * exports: `lib/run-export.ts` writes these files to Google Drive, Box or
 * OneDrive on a timer, with nobody in the loop to notice a suspicious cell
 * before it reaches whoever opens the shared folder.
 *
 * ── Why the .xlsx writers are deliberately NOT changed ───────────────────────
 * Verified against the bytes SheetJS actually emits, not assumed:
 * `XLSX.utils.json_to_sheet` produces string cells, and the written worksheet
 * XML is `<c r="A2" t="str"><v>=1+1</v></c>` — with **no `<f>` element**. A
 * formula in SpreadsheetML *is* the `<f>` element, so there is nothing for the
 * reader to evaluate and the text is displayed literally. Prefixing those cells
 * would put a visible apostrophe in the spreadsheet for no security gain.
 * If the workbook writer is ever changed (a different library, or `json_to_sheet`
 * swapped for something that infers formulas), re-check that and route the
 * xlsx paths through here too.
 */

/** Characters that make a spreadsheet treat an imported CSV field as a formula. */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * A plain signed number or measurement: `-12`, `+3.5`, `-1,234`, `-12%`, or a
 * lone sign. These begin with `+`/`-` but cannot be formulas, and they are
 * ordinary report output — percentage deltas above all. Escaping them would put
 * a stray apostrophe into legitimate data that downstream systems then have to
 * parse around, so they are exempt. Anything with an operator after the sign
 * (`-1+1`) fails this and is escaped.
 */
const PLAIN_NUMBER = /^[+-]?[\d.,]*\s*%?$/;

/**
 * Prefix a formula-triggering CSV value with an apostrophe, leaving everything
 * else byte-identical.
 *
 * Non-strings are returned untouched: a real number stays a real number, so
 * negative values keep their type and their formatting. Only a *string* can
 * carry an operator, and only a string is at risk.
 */
export function csvSafeCell<T>(value: T): T | string {
  if (typeof value !== "string" || value === "") return value;
  if (!FORMULA_LEAD.has(value[0])) return value;
  if (PLAIN_NUMBER.test(value)) return value;
  return `'${value}`;
}

/**
 * Apply `csvSafeCell` across one already-built row object.
 *
 * The three CSV writers each construct `Record<header, value>` rows just before
 * handing them to `Papa.unparse`; mapping here keeps the neutralisation beside
 * the sink rather than in each of the ~20 pages that call an exporter, so a new
 * export path inherits it. Same principle as `deliverLocal` re-asserting its own
 * path containment instead of trusting its caller.
 */
export function csvSafeRows<T extends Record<string, unknown>>(rows: T[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, csvSafeCell(v)]))
  );
}
