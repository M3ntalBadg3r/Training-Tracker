import Papa from "papaparse";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { downloadBlob } from "@/lib/export";

/**
 * Multi-section report export.
 *
 * The single-table utilities in `lib/export.ts` (exportToCsv/Excel/Pdf) each
 * emit one flat table. A "whole-page" report — Compliance Planning today, other
 * report pages later — is really several structurally different tables that need
 * to travel together in one file. This module models such a report as a
 * `ReportDocument` (title + meta + ordered sections) and renders it to CSV
 * (stacked with section titles), Excel (one sheet per section) and PDF (stacked
 * headed tables).
 *
 * The `ReportImageSection` variant is an intentional, not-yet-emitted hook for
 * embedding captured charts. The PDF generator already places image sections via
 * `doc.addImage`, so a future "export charts too" change only has to produce the
 * PNG data URLs and push image sections into the document.
 */

export interface ReportTableSection {
  kind?: "table";
  title: string;
  /** Optional caption printed under the section title. */
  subtitle?: string;
  columns: { key: string; header: string }[];
  rows: Record<string, string | number>[];
}

/**
 * FUTURE: a rendered chart embedded as an image. No caller emits these yet, but
 * the document model + PDF generator support them so charts can be added later
 * without touching this contract.
 */
export interface ReportImageSection {
  kind: "image";
  title: string;
  subtitle?: string;
  /** PNG/JPEG data URL of a captured chart. */
  dataUrl: string;
  /** width / height, used to size the image in the PDF. Defaults to 2. */
  aspectRatio?: number;
}

export type ReportSection = ReportTableSection | ReportImageSection;

export interface ReportDocument {
  title: string;
  /** Key/value context lines (Scope, Renewal window, Generated, …). */
  meta?: { label: string; value: string }[];
  sections: ReportSection[];
}

function isTableSection(s: ReportSection): s is ReportTableSection {
  return s.kind !== "image";
}

/** Same cell rules as lib/export.ts: arrays join with ", ", null/undefined → "". */
function cell(val: string | number | undefined | null): string | number {
  return Array.isArray(val) ? val.join(", ") : val ?? "";
}

function toHeaderKeyedRows(section: ReportTableSection): Record<string, string | number>[] {
  return section.rows.map((row) =>
    Object.fromEntries(section.columns.map((col) => [col.header, cell(row[col.key])]))
  );
}

// ── CSV — one file, sections stacked with title separators ──
export function exportReportToCsv(doc: ReportDocument, filename: string): void {
  const blocks: string[] = [];
  blocks.push(Papa.unparse([[doc.title]]));
  if (doc.meta && doc.meta.length > 0) {
    blocks.push(Papa.unparse(doc.meta.map((m) => [m.label, m.value])));
  }
  for (const section of doc.sections) {
    blocks.push(""); // blank separator line
    if (isTableSection(section)) {
      const header = section.subtitle ? `${section.title} — ${section.subtitle}` : section.title;
      blocks.push(Papa.unparse([[header]]));
      blocks.push(Papa.unparse(toHeaderKeyedRows(section)));
    } else {
      blocks.push(Papa.unparse([[`${section.title} (chart omitted from CSV export)`]]));
    }
  }
  downloadBlob(blocks.join("\n"), `${filename}.csv`, "text/csv;charset=utf-8;");
}

// ── Excel — one sheet per table section ──
export function exportReportToExcel(doc: ReportDocument, filename: string): void {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();

  // Excel sheet names: max 31 chars, no []:*?/\, must be unique.
  const uniqueName = (name: string): string => {
    const base = (name || "Sheet").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
    let candidate = base;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = ` (${n++})`;
      candidate = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  };

  if (doc.meta && doc.meta.length > 0) {
    const summary = XLSX.utils.aoa_to_sheet([
      [doc.title],
      [],
      ...doc.meta.map((m) => [m.label, m.value]),
    ]);
    XLSX.utils.book_append_sheet(wb, summary, uniqueName("Overview"));
  }

  for (const section of doc.sections) {
    if (!isTableSection(section)) continue; // images not embedded in xlsx yet
    const ws = XLSX.utils.json_to_sheet(toHeaderKeyedRows(section));
    XLSX.utils.book_append_sheet(wb, ws, uniqueName(section.title));
  }

  // XLSX requires at least one sheet.
  if (wb.SheetNames.length === 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[doc.title]]), uniqueName("Report"));
  }
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

// ── PDF — stacked headed tables (+ image sections for future charts) ──
export function exportReportToPdf(doc: ReportDocument, filename: string): void {
  const widestCols = doc.sections.reduce(
    (max, s) => (isTableSection(s) ? Math.max(max, s.columns.length) : max),
    0
  );
  const pdf = new jsPDF({ orientation: widestCols > 6 ? "landscape" : "portrait" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 14;

  pdf.setFontSize(16);
  pdf.text(doc.title, margin, 18);

  let y = 26;
  if (doc.meta && doc.meta.length > 0) {
    pdf.setFontSize(9);
    pdf.setTextColor(90);
    for (const m of doc.meta) {
      pdf.text(`${m.label}: ${m.value}`, margin, y);
      y += 5;
    }
    pdf.setTextColor(0);
    y += 2;
  }

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - margin) {
      pdf.addPage();
      y = margin + 4;
    }
  };

  for (const section of doc.sections) {
    ensureSpace(16);
    pdf.setFontSize(12);
    pdf.text(section.title, margin, y);
    y += 5;
    if (section.subtitle) {
      pdf.setFontSize(8);
      pdf.setTextColor(120);
      pdf.text(section.subtitle, margin, y);
      pdf.setTextColor(0);
      y += 5;
    }

    if (isTableSection(section)) {
      autoTable(pdf, {
        head: [section.columns.map((c) => c.header)],
        body: section.rows.map((row) =>
          section.columns.map((c) => String(cell(row[c.key])))
        ),
        startY: y + 1,
        margin: { left: margin, right: margin },
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [51, 51, 51] },
      });
      // jspdf-autotable stashes the last table's end Y on the doc instance.
      y = (pdf as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;
      y += 8;
    } else {
      // Future chart hook: place the captured image scaled to the content width.
      const ratio = section.aspectRatio && section.aspectRatio > 0 ? section.aspectRatio : 2;
      const imgWidth = pageWidth - margin * 2;
      const imgHeight = imgWidth / ratio;
      ensureSpace(imgHeight + 4);
      pdf.addImage(section.dataUrl, "PNG", margin, y, imgWidth, imgHeight);
      y += imgHeight + 8;
    }
  }

  pdf.save(`${filename}.pdf`);
}
