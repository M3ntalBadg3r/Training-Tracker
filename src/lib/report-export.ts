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
 * `ReportImageSection` carries a captured chart. `lib/chart-capture.ts` produces
 * the PNG data URLs and `exportReportTablePdf` (below) assembles them, so a
 * report page's PDF can lead with its charts. Only the PDF renderer draws them:
 * CSV has nowhere to put an image, and Excel is written with SheetJS's community
 * build, which cannot embed one.
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
 * A rendered chart embedded as an image. Produced by `lib/chart-capture.ts`;
 * drawn only by the PDF renderer (CSV and Excel skip it).
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
  // Captured charts are wide (~2-3:1). At the portrait content width one is only
  // ~70mm tall, so images alone need not force a flip — but a document that is
  // *only* charts should still get the wider page, which the column count alone
  // could never tell us.
  const hasWideImage = doc.sections.some((s) => !isTableSection(s) && (s.aspectRatio ?? 2) >= 2.2);
  const landscape = widestCols > 6 || (widestCols === 0 && hasWideImage);
  const pdf = new jsPDF({ orientation: landscape ? "landscape" : "portrait" });
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

  const contentWidth = pageWidth - margin * 2;

  const drawHeading = (section: ReportSection) => {
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
  };

  for (const section of doc.sections) {
    const headingHeight = 5 + (section.subtitle ? 5 : 0);

    if (isTableSection(section)) {
      ensureSpace(16);
      drawHeading(section);
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
      const ratio = section.aspectRatio && section.aspectRatio > 0 ? section.aspectRatio : 2;
      let imgWidth = contentWidth;
      let imgHeight = imgWidth / ratio;

      // A tall image must be scaled to fit. Reserving space for it instead would
      // just add a blank page and overflow that one too.
      const maxHeight = pageHeight - margin * 2 - headingHeight - 8;
      if (imgHeight > maxHeight) {
        imgHeight = maxHeight;
        imgWidth = imgHeight * ratio;
      }

      // One reservation covering heading *and* image, so a section title can
      // never be left stranded at the foot of a page with its chart overleaf.
      ensureSpace(headingHeight + imgHeight + 8);
      drawHeading(section);
      pdf.addImage(section.dataUrl, "PNG", margin + (contentWidth - imgWidth) / 2, y, imgWidth, imgHeight);
      y += imgHeight + 8;
    }
  }

  pdf.save(`${filename}.pdf`);
}

/**
 * Export one report page — a single data table, optionally led by its charts —
 * as a PDF.
 *
 * Report pages route *all* their PDF exports through here, whether or not
 * charts were requested. Falling back to `lib/export.ts`'s `exportToPdf` when
 * the box is unticked would make the same report produce a visibly different
 * document depending on a checkbox: that one titles the page from the filename
 * at 14pt with no section heading, and picks its orientation on a different
 * threshold (`columns.length > 5` here vs `widestCols > 6`), so a six-column
 * report would silently flip between portrait and landscape.
 *
 * CSV and Excel deliberately stay on the `lib/export.ts` helpers — routing them
 * here would change file *contents* (an extra Overview sheet, a renamed data
 * sheet) that the server-side scheduled exports do not mirror.
 */
export function exportReportTablePdf(opts: {
  title: string;
  filename: string;
  columns: { key: string; header: string }[];
  rows: Record<string, string | number>[];
  meta?: { label: string; value: string }[];
  /** Heading above the data table. Defaults to "Data". */
  tableTitle?: string;
  /** Captured charts, drawn above the table in the order they appear on the page. */
  charts?: { title: string; dataUrl: string; aspectRatio: number }[];
}): void {
  const sections: ReportSection[] = [
    ...(opts.charts ?? []).map((chart) => ({
      kind: "image" as const,
      title: chart.title,
      dataUrl: chart.dataUrl,
      aspectRatio: chart.aspectRatio,
    })),
    { title: opts.tableTitle ?? "Data", columns: opts.columns, rows: opts.rows },
  ];
  exportReportToPdf({ title: opts.title, meta: opts.meta, sections }, opts.filename);
}
