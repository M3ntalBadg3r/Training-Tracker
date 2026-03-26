/**
 * Server-side export utilities — return Buffer instead of triggering browser downloads.
 * These mirror src/lib/export.ts but work in Node.js API routes.
 */

import Papa from "papaparse";
import * as XLSX from "xlsx";

export interface ExportColumn<T> {
  key: keyof T;
  header: string;
}

export function serverExportToCsv<T extends object>(
  data: T[],
  columns: ExportColumn<T>[]
): Buffer {
  const rows = data.map((row) =>
    Object.fromEntries(
      columns.map((col) => {
        const val = row[col.key];
        return [col.header, Array.isArray(val) ? val.join(", ") : (val ?? "")];
      })
    )
  );
  const csv = Papa.unparse(rows);
  return Buffer.from(csv, "utf-8");
}

export function serverExportToExcel<T extends object>(
  data: T[],
  columns: ExportColumn<T>[]
): Buffer {
  const rows = data.map((row) =>
    Object.fromEntries(
      columns.map((col) => {
        const val = row[col.key];
        return [col.header, Array.isArray(val) ? val.join(", ") : (val ?? "")];
      })
    )
  );
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function serverExportToPdf<T extends object>(
  data: T[],
  columns: ExportColumn<T>[],
  title: string
): Buffer {
  // Use jsPDF in Node.js mode
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { jsPDF } = require("jspdf");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const autoTable = require("jspdf-autotable").default;

  const doc = new jsPDF({
    orientation: columns.length > 5 ? "landscape" : "portrait",
  });
  doc.setFontSize(14);
  doc.text(
    title.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
    14,
    15
  );

  const headers = columns.map((col) => col.header);
  const rows = data.map((row) =>
    columns.map((col) => {
      const val = row[col.key];
      return Array.isArray(val) ? val.join(", ") : String(val ?? "");
    })
  );

  autoTable(doc, {
    head: [headers],
    body: rows,
    startY: 22,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [51, 51, 51] },
  });

  const arrayBuf: ArrayBuffer = doc.output("arraybuffer");
  return Buffer.from(arrayBuf);
}

export function getFileExtension(format: string): string {
  switch (format) {
    case "excel":
      return "xlsx";
    case "pdf":
      return "pdf";
    default:
      return "csv";
  }
}

export function getMimeType(format: string): string {
  switch (format) {
    case "excel":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pdf":
      return "application/pdf";
    default:
      return "text/csv";
  }
}

export function generateExportBuffer<T extends object>(
  data: T[],
  columns: ExportColumn<T>[],
  format: string,
  title: string
): Buffer {
  switch (format) {
    case "excel":
      return serverExportToExcel(data, columns);
    case "pdf":
      return serverExportToPdf(data, columns, title);
    default:
      return serverExportToCsv(data, columns);
  }
}
