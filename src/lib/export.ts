import Papa from "papaparse";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { csvSafeRows } from "@/lib/export-cell";

export function exportToCsv<T extends object>(
  data: T[],
  columns: { key: keyof T; header: string }[],
  filename: string
) {
  const rows = data.map((row) =>
    Object.fromEntries(columns.map((col) => {
      const val = row[col.key];
      return [col.header, Array.isArray(val) ? val.join(", ") : val ?? ""];
    }))
  );
  const csv = Papa.unparse(csvSafeRows(rows));
  downloadBlob(csv, `${filename}.csv`, "text/csv;charset=utf-8;");
}

export function exportToExcel<T extends object>(
  data: T[],
  columns: { key: keyof T; header: string }[],
  filename: string
) {
  const rows = data.map((row) =>
    Object.fromEntries(columns.map((col) => {
      const val = row[col.key];
      return [col.header, Array.isArray(val) ? val.join(", ") : val ?? ""];
    }))
  );
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

/**
 * Make a string safe for jsPDF's built-in fonts.
 *
 * The standard PDF fonts are WinAnsi-encoded, which is **CP1252 — Latin-1 plus
 * the 0x80-0x9F range**. A character outside CP1252 is emitted as raw UTF-16
 * bytes and comes out as mojibake with the wrong advance widths: "Lapsed ≤ 1
 * month" prints as `Lapsed "d 1 month`, ≤ being U+2264 and 0x22 0x64 being `"d`.
 * Report text is full of those (≤ in the expiry buckets, → in "ILT → Cert", ▼ in
 * the expiring notes, ✓ in the compliance columns), so they are transliterated
 * to their ASCII equivalents.
 *
 * CP1252 is the boundary, and reading it as Latin-1 is a mistake that has
 * already been made here. That extra 0x80-0x9F range holds the ellipsis (0x85),
 * the en and em dashes (0x96/0x97), the curly quotes (0x91-0x94) and the bullet
 * (0x95) — jsPDF encodes every one of them correctly, so the entries for them
 * below are long-standing behaviour rather than a correctness requirement.
 *
 * Do not remove those entries regardless. Every existing report PDF would
 * change bytes, and two of the classes straddle the boundary in any case: the
 * dash class also covers ‐ ‑ ‒ ― and −, and the quote class also covers ‛, none
 * of which CP1252 has. Someone taking "outside Latin-1" at face value once
 * "fixed" the deliberate ellipsis in `report-export.ts:fitLine` by running it
 * through this table, turning one glyph into three dots and — `...` being the
 * wider — moving where every truncated label in the twelve report pages is cut.
 *
 * Anything CP1252 already covers is left exactly as it is — accented names
 * above all, but also × and · — and embedding a Unicode font to keep the real
 * glyphs would cost hundreds of kilobytes in the client bundle.
 */
const PDF_TRANSLITERATIONS: [RegExp, string][] = [
  [/[\u2018\u2019\u201b]/g, "'"],
  [/[\u201c\u201d\u201e]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, "-"],
  [/\u2026/g, "..."],
  [/\u2264/g, "<="],
  [/\u2265/g, ">="],
  [/\u2260/g, "!="],
  [/\u2192/g, "->"],
  [/\u2190/g, "<-"],
  [/\u25b2/g, "^"],
  [/\u25bc/g, "v"],
  [/\u2022/g, "-"],
  // Check and cross marks: compliance tables are full of them, and unlike the
  // ellipsis, bullet and curly quotes above they are genuinely outside CP1252,
  // so without an entry each arrives as mojibake in the column a reader scans
  // first.
  [/[\u2713\u2714]/g, "OK"],
  [/[\u2715-\u2718]/g, "X"],
  [/[\u2009\u202f]/g, " "],
];

export function pdfSafe(text: string): string {
  return PDF_TRANSLITERATIONS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

export function exportToPdf<T extends object>(
  data: T[],
  columns: { key: keyof T; header: string }[],
  filename: string
) {
  const headers = columns.map((col) => pdfSafe(col.header));
  const rows = data.map((row) =>
    columns.map((col) => {
      const val = row[col.key];
      return pdfSafe(Array.isArray(val) ? val.join(", ") : String(val ?? ""));
    })
  );

  const doc = new jsPDF({ orientation: columns.length > 5 ? "landscape" : "portrait" });
  doc.setFontSize(14);
  doc.text(pdfSafe(filename.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())), 14, 15);

  autoTable(doc, {
    head: [headers],
    body: rows,
    startY: 22,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [51, 51, 51] },
  });

  doc.save(`${filename}.pdf`);
}

export function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
