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

export function exportToPdf<T extends object>(
  data: T[],
  columns: { key: keyof T; header: string }[],
  filename: string
) {
  const headers = columns.map((col) => col.header);
  const rows = data.map((row) =>
    columns.map((col) => {
      const val = row[col.key];
      return Array.isArray(val) ? val.join(", ") : String(val ?? "");
    })
  );

  const doc = new jsPDF({ orientation: columns.length > 5 ? "landscape" : "portrait" });
  doc.setFontSize(14);
  doc.text(filename.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), 14, 15);

  autoTable(doc, {
    head: [headers],
    body: rows,
    startY: 22,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [51, 51, 51] },
  });

  doc.save(`${filename}.pdf`);
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
