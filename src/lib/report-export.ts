import Papa from "papaparse";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { downloadBlob, pdfSafe } from "@/lib/export";

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
 * `ReportImageSection` carries a band of captured charts and `ReportDocument.kpis`
 * the page's metric boxes. `lib/chart-capture.ts` produces the PNG data URLs and
 * `exportReportTablePdf` (below) assembles both, so a report page's PDF opens
 * with the same metrics and charts the page shows. Only the PDF renderer draws
 * them: CSV has nowhere to put an image, and Excel is written with SheetJS's
 * community build, which cannot embed one.
 */

export interface ReportTableSection {
  kind?: "table";
  title: string;
  /** Optional caption printed under the section title. */
  subtitle?: string;
  columns: { key: string; header: string }[];
  rows: Record<string, string | number>[];
}

/** One captured chart. Produced by `lib/chart-capture.ts`. */
export interface ReportChartImage {
  title: string;
  /** PNG/JPEG data URL of a captured chart. */
  dataUrl: string;
  /** width / height, used to size the image in the PDF. Defaults to 2. */
  aspectRatio?: number;
  /** Share of the band's width. Omitted (or zero) means an equal share. */
  widthFraction?: number;
  /** Index of the on-screen row this chart came from; set by `exportReportTablePdf`. */
  row?: number;
}

/**
 * One *band* of charts, drawn side by side across the content width — so a pair
 * that sits side by side on the report page comes out side by side in the PDF
 * rather than stacked at full width, where each would be needlessly tall.
 *
 * Drawn only by the PDF renderer: CSV has nowhere to put an image and Excel is
 * written with SheetJS's community build, which cannot embed one.
 */
export interface ReportImageSection {
  kind: "image";
  images: ReportChartImage[];
}

export type ReportSection = ReportTableSection | ReportImageSection;

/**
 * One metric box from the page's `KpiStrip`, redrawn in the PDF with jsPDF
 * primitives rather than captured as a picture — the values are text, so
 * drawing them keeps them crisp, selectable and searchable at any zoom.
 *
 * `value` is the string the page *renders* (already `toLocaleString()`d, or
 * pre-formatted like "45%"), so the PDF cannot disagree with the screen.
 */
export type ReportKpiTone = "blue" | "green" | "amber" | "red" | "indigo" | "emerald";

export interface ReportKpi {
  label: string;
  value: string;
  hint?: string;
  tone?: ReportKpiTone;
}

export interface ReportDocument {
  title: string;
  /** Key/value context lines (Scope, Renewal window, Generated, …). */
  meta?: { label: string; value: string }[];
  /** Metric boxes drawn under the meta block, ahead of the first section. */
  kpis?: ReportKpi[];
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
      blocks.push(
        Papa.unparse(section.images.map((img) => [`${img.title} (chart omitted from CSV export)`]))
      );
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

// ── PDF — KPI boxes, banded chart images, then stacked headed tables ──

/**
 * Accent colours for the KPI boxes, keyed by the same tone names `KpiStrip`
 * uses. Kept here rather than imported from the component: `KpiStrip` is a
 * `"use client"` React module, and a colour table is not worth pulling one into
 * an export library for. These are the Tailwind 500 shades behind its classes.
 */
const KPI_TONE_HEX: Record<ReportKpiTone, string> = {
  blue: "#3b82f6",
  green: "#22c55e",
  amber: "#f59e0b",
  red: "#ef4444",
  indigo: "#6366f1",
  emerald: "#10b981",
};

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

export function exportReportToPdf(doc: ReportDocument, filename: string): void {
  const widestCols = doc.sections.reduce(
    (max, s) => (isTableSection(s) ? Math.max(max, s.columns.length) : max),
    0
  );
  // Captured charts are wide (~2-3:1). At the portrait content width one is only
  // ~70mm tall, so images alone need not force a flip — but a document that is
  // *only* charts should still get the wider page, which the column count alone
  // could never tell us. A band of two is a separate matter: half of a 182mm
  // portrait column is too narrow for a chart to stay legible, so any such band
  // takes the wider page whatever the tables want. (No report today flips on
  // this — every one with two charts already has more than six columns — so a
  // report's orientation still does not depend on the export tickbox.)
  const hasWideImage = doc.sections.some(
    (s) => !isTableSection(s) && s.images.some((img) => (img.aspectRatio ?? 2) >= 2.2)
  );
  const hasImageBand = doc.sections.some((s) => !isTableSection(s) && s.images.length >= 2);
  const landscape = widestCols > 6 || hasImageBand || (widestCols === 0 && hasWideImage);
  const pdf = new jsPDF({ orientation: landscape ? "landscape" : "portrait" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 14;

  pdf.setFontSize(16);
  pdf.text(pdfSafe(doc.title), margin, 18);

  let y = 26;
  if (doc.meta && doc.meta.length > 0) {
    pdf.setFontSize(9);
    pdf.setTextColor(90);
    for (const m of doc.meta) {
      pdf.text(pdfSafe(`${m.label}: ${m.value}`), margin, y);
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

  /**
   * First line only — a wrapped label would push everything below it out of
   * line. Marked with an ellipsis when something was dropped, matching the
   * `truncate` the KPI cards use on screen.
   */
  const fitLine = (text: string, width: number): string => {
    const lines = pdf.splitTextToSize(pdfSafe(text), width) as string[];
    if (lines.length <= 1) return lines[0] ?? "";
    return `${lines[0].replace(/\s+$/, "")}…`;
  };

  // ── KPI boxes, four to a row like the on-screen strip ──
  if (doc.kpis && doc.kpis.length > 0) {
    const cols = 4;
    const gap = 4;
    const boxW = (contentWidth - gap * (cols - 1)) / cols;
    // One height for every box so the rows line up, tall enough for a hint only
    // when some card actually has one.
    const boxH = doc.kpis.some((k) => k.hint) ? 17 : 13;
    const stripe = 1.6;
    const padX = stripe + 3;

    for (let i = 0; i < doc.kpis.length; i += cols) {
      const row = doc.kpis.slice(i, i + cols);
      ensureSpace(boxH + 4);
      row.forEach((kpi, col) => {
        const x = margin + col * (boxW + gap);
        pdf.setDrawColor(229);
        pdf.setLineWidth(0.2);
        pdf.roundedRect(x, y, boxW, boxH, 1.5, 1.5, "S");
        pdf.setFillColor(...hexToRgb(KPI_TONE_HEX[kpi.tone ?? "blue"]));
        pdf.rect(x + 0.1, y + 0.1, stripe, boxH - 0.2, "F");

        pdf.setFontSize(13);
        pdf.setTextColor(17);
        pdf.text(fitLine(kpi.value, boxW - padX - 3), x + padX, y + 7);
        pdf.setFontSize(8);
        pdf.setTextColor(107);
        pdf.text(fitLine(kpi.label, boxW - padX - 3), x + padX, y + 11.2);
        if (kpi.hint) {
          pdf.setFontSize(7);
          pdf.setTextColor(150);
          pdf.text(fitLine(kpi.hint, boxW - padX - 3), x + padX, y + 14.8);
        }
      });
      y += boxH + 4;
    }
    pdf.setTextColor(0);
    pdf.setLineWidth(0.2);
    y += 4;
  }

  const drawHeading = (title: string, subtitle?: string) => {
    pdf.setFontSize(12);
    pdf.text(pdfSafe(title), margin, y);
    y += 5;
    if (subtitle) {
      pdf.setFontSize(8);
      pdf.setTextColor(120);
      pdf.text(pdfSafe(subtitle), margin, y);
      pdf.setTextColor(0);
      y += 5;
    }
  };

  for (const section of doc.sections) {
    if (isTableSection(section)) {
      ensureSpace(16);
      drawHeading(section.title, section.subtitle);
      autoTable(pdf, {
        head: [section.columns.map((c) => pdfSafe(c.header))],
        body: section.rows.map((row) =>
          section.columns.map((c) => pdfSafe(String(cell(row[c.key]))))
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
      const images = section.images;
      if (images.length === 0) continue;
      const gap = 6;
      const headingHeight = 5;
      const available = contentWidth - gap * (images.length - 1);

      // Columns keep the widths the cards had on screen, so a wide chart beside
      // a donut prints 2:1 as it does on the page. Equal shares when the
      // fractions are missing or degenerate.
      const fractions = images.map((img) => img.widthFraction ?? 0);
      const fractionTotal = fractions.reduce((a, b) => a + b, 0);
      const colWidths =
        fractionTotal > 0
          ? fractions.map((f) => (f / fractionTotal) * available)
          : images.map(() => available / images.length);
      const colX = colWidths.map(
        (_, i) => margin + colWidths.slice(0, i).reduce((a, b) => a + b, 0) + gap * i
      );

      let sizes = images.map((img, i) => {
        const ratio = img.aspectRatio && img.aspectRatio > 0 ? img.aspectRatio : 2;
        return { w: colWidths[i], h: colWidths[i] / ratio };
      });
      // A tall band must be scaled to fit. Reserving space for it instead would
      // just add a blank page and overflow that one too. Scaling the whole band
      // by one factor keeps the columns aligned.
      let bandHeight = Math.max(...sizes.map((s) => s.h));
      const maxHeight = pageHeight - margin * 2 - headingHeight - 8;
      if (bandHeight > maxHeight) {
        const k = maxHeight / bandHeight;
        sizes = sizes.map((s) => ({ w: s.w * k, h: s.h * k }));
        bandHeight = maxHeight;
      }

      // One reservation covering headings *and* images, so a chart title can
      // never be left stranded at the foot of a page with its chart overleaf.
      ensureSpace(headingHeight + bandHeight + 8);
      pdf.setFontSize(images.length > 1 ? 10 : 12);
      images.forEach((img, i) => {
        pdf.text(fitLine(img.title, colWidths[i]), colX[i], y);
      });
      y += headingHeight;
      images.forEach((img, i) => {
        pdf.addImage(
          img.dataUrl,
          "PNG",
          colX[i] + (colWidths[i] - sizes[i].w) / 2,
          y,
          sizes[i].w,
          sizes[i].h
        );
      });
      y += bandHeight + 8;
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
  charts?: ReportChartImage[];
  /** The page's metric boxes, drawn under the title ahead of the charts. */
  kpis?: ReportKpi[];
}): void {
  // One band per on-screen row, so the PDF reproduces the page's chart layout:
  // a side-by-side pair stays side by side (keeping its width proportions),
  // and a chart that spans the page keeps the full width. `row` comes from the
  // captured geometry — see `chart-capture.ts:layoutRows`.
  const bands: ReportSection[] = [];
  for (const chart of opts.charts ?? []) {
    const last = bands[bands.length - 1] as ReportImageSection | undefined;
    const sameRow = last && last.images[last.images.length - 1].row === chart.row;
    if (sameRow && chart.row !== undefined) last.images.push(chart);
    else bands.push({ kind: "image", images: [chart] });
  }

  exportReportToPdf(
    {
      title: opts.title,
      meta: opts.meta,
      kpis: opts.kpis,
      sections: [
        ...bands,
        { title: opts.tableTitle ?? "Data", columns: opts.columns, rows: opts.rows },
      ],
    },
    opts.filename
  );
}
