import Papa from "papaparse";
import * as XLSX from "xlsx";

export function exportToCsv<T extends object>(
  data: T[],
  columns: { key: keyof T; header: string }[],
  filename: string
) {
  const rows = data.map((row) =>
    Object.fromEntries(columns.map((col) => [col.header, row[col.key] ?? ""]))
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
    Object.fromEntries(columns.map((col) => [col.header, row[col.key] ?? ""]))
  );
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
