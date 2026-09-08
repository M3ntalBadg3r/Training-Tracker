import Papa from "papaparse";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

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
  const csv = Papa.unparse(rows);
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
 * The standard PDF fonts are WinAnsi-encoded: a character outside Latin-1 is
 * emitted as raw UTF-16 bytes and comes out as mojibake with the wrong advance
 * widths — "Lapsed ≤ 1 month" prints as `Lapsed "d 1 month`. Report text is full
 * of such characters (≤ in the expiry buckets, → in "ILT → Cert", en and em
 * dashes throughout the chart titles), so they are transliterated to their
 * ASCII equivalents. Anything Latin-1 already covers is left exactly as it is —
 * accented names above all, but also × and · — and embedding a Unicode font to
 * keep the real glyphs would cost hundreds of kilobytes in the client bundle.
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
