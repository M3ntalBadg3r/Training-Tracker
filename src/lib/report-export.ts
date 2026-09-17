import Papa from "papaparse";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { Cell, CellDef, RowInput, Styles, UserOptions } from "jspdf-autotable";
import { downloadBlob, pdfSafe } from "@/lib/export";
import { csvSafeCell, csvSafeRows } from "@/lib/export-cell";

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
 *
 * Everything beyond a flat table is **opt-in**. A page whose document sets none
 * of the presentational fields below (`groups`, `lead`, `badge`, `emptyText`,
 * column `width`/`align`, rich cells, toned rows, note sections, `pdfSections`,
 * `orientation`) travels the exact code path it did before those fields existed
 * — same autoTable options object, same `y` arithmetic, same file. That is a
 * hard requirement rather than a nicety: thirteen report pages reach this module
 * through `exportReportTablePdf` and none of them asked for a redesign.
 */

/**
 * The semantic states the report pages shade with: a shortfall (red), something
 * compliant today but at risk inside the renewal window (amber), a met
 * requirement (green), de-emphasised reference data (muted) and ordinary
 * unshaded text (neutral).
 */
export type ReportTone = "red" | "amber" | "green" | "muted" | "neutral";

/**
 * A cell that carries presentation as well as a value.
 *
 * Only the PDF renderer reads anything but `text`: CSV and Excel are data
 * interchange formats whose consumers (and the server-side scheduled exports
 * they must keep matching) have nowhere to put a colour or a second line.
 */
export interface ReportRichCell {
  /** The main line, e.g. "4 -> 2 / 4". */
  text: string;
  /** A small grey second line under it, e.g. "2 expiring". */
  sub?: string;
  tone?: ReportTone;
  bold?: boolean;
  align?: "left" | "center" | "right";
}

export type ReportCellValue = string | number | ReportRichCell;

/**
 * A body row that tints as a whole, mirroring the row shading on the page, and
 * can carry indented continuation lines under it the way the page's expander
 * does.
 */
export interface ReportTonedRow {
  tone?: ReportTone;
  cells: Record<string, ReportCellValue>;
  /** Indented continuation lines drawn under the row, like the page's expander. */
  detail?: string[];
}

/**
 * A plain object keyed by column is still a row, which is what keeps every
 * existing call site — all of which pass `Record<string, string | number>` —
 * compiling and rendering unchanged.
 */
export type ReportRow = Record<string, ReportCellValue> | ReportTonedRow;

/**
 * One card inside a table section: the page's per-specialisation block, drawn as
 * a headed band of rows rather than a separate table, so the columns stay
 * aligned down the whole section and autoTable keeps paginating for us.
 */
export interface ReportRowGroup {
  title: string;
  badge?: string;
  badgeTone?: ReportTone;
  subtitle?: string;
  rows: ReportRow[];
  /** A closing line under the group's rows, e.g. why it is only shown for reference. */
  note?: string;
}

export interface ReportTableSection {
  kind?: "table";
  title: string;
  /** Optional caption printed under the section title. */
  subtitle?: string;
  /** A paragraph under the heading and above the table, wrapped to the page. */
  lead?: string;
  /** A right-aligned label on the heading line, e.g. a count or a scope. */
  badge?: string;
  /**
   * Colour for `badge`. A heading badge is usually a status the reader is
   * scanning for — Met, At Risk, Not Compliant — and printing it in the same
   * grey as a row count throws away the one cue that makes a long document
   * skimmable. Omitted leaves it grey, which is what a plain count wants.
   */
  badgeTone?: ReportTone;
  columns: {
    key: string;
    header: string;
    /**
     * Relative weight. When *any* column declares one the whole row of widths is
     * normalised across the content width and undeclared columns weigh 1 — an
     * eighteen-column table left to autoTable's own division wraps its headers to
     * one word per line, which is the defect this exists to fix.
     */
    width?: number;
    align?: "left" | "center" | "right";
  }[];
  rows: ReportRow[];
  /** Cards to draw instead of `rows`. PDF only; CSV/Excel flatten them. */
  groups?: ReportRowGroup[];
  /** Drawn in place of a headers-only table when there is nothing to show. */
  emptyText?: string;
}

/**
 * A standalone prose block: a banner, a callout, an empty state. Drawn as a
 * tinted panel rather than a table because it has no columns to speak of, and a
 * one-cell table would inherit the table's borders and header row.
 */
export interface ReportNoteSection {
  kind: "note";
  title?: string;
  lines: string[];
  tone?: ReportTone;
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

export type ReportSection = ReportTableSection | ReportImageSection | ReportNoteSection;

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
  /**
   * PDF-only override. When present the PDF renderer draws these instead of
   * `sections`; CSV and Excel always read `sections`.
   *
   * This exists because the two audiences genuinely want different documents. A
   * spreadsheet wants one wide rectangle per section that can be sorted and
   * pivoted; the printed page wants the screen's cards, shading and two-line
   * cells. Forcing one shape to serve both is what makes an eighteen-column
   * table land in a PDF in the first place.
   */
  pdfSections?: ReportSection[];
  /** Force page orientation. Omitted keeps the column-count heuristic below. */
  orientation?: "portrait" | "landscape";
}

function isTableSection(s: ReportSection): s is ReportTableSection {
  return s.kind === undefined || s.kind === "table";
}

function isNoteSection(s: ReportSection): s is ReportNoteSection {
  return s.kind === "note";
}

/** Narrowing helpers, exported so the pages building documents need not restate them. */
export function isRichCell(v: ReportCellValue): v is ReportRichCell {
  return typeof v === "object" && v !== null && typeof (v as ReportRichCell).text === "string";
}

export function isTonedRow(r: ReportRow): r is ReportTonedRow {
  const candidate = r as ReportTonedRow;
  return typeof candidate.cells === "object" && candidate.cells !== null;
}

function rowCells(row: ReportRow): Record<string, ReportCellValue> {
  return isTonedRow(row) ? row.cells : row;
}

/**
 * Same cell rules as lib/export.ts: arrays join with ", ", null/undefined → "".
 * A rich cell collapses to its main line, which is the whole of its data — the
 * `sub` is a presentational restatement of something already in another column
 * (an expiry count, a projection), so keeping it out of CSV/Excel loses nothing
 * and keeps those files rectangular.
 */
function cell(val: ReportCellValue | undefined | null): string | number {
  if (Array.isArray(val)) return val.join(", ");
  if (val != null && isRichCell(val)) return val.text;
  return val ?? "";
}

/**
 * The rows CSV and Excel read. `groups` is a PDF-only presentation of the same
 * data, so when a section carries groups *instead of* rows the flattened group
 * rows are what the data formats get; a section that has both keeps `rows` as
 * the authoritative flat shape.
 */
function sectionRows(section: ReportTableSection): ReportRow[] {
  if (section.rows.length > 0 || !section.groups) return section.rows;
  return section.groups.flatMap((g) => g.rows);
}

function toHeaderKeyedRows(section: ReportTableSection): Record<string, string | number>[] {
  return sectionRows(section).map((row) => {
    const cells = rowCells(row);
    return Object.fromEntries(section.columns.map((col) => [col.header, cell(cells[col.key])]));
  });
}

/**
 * A section's rows flattened back to the plain, column-*key*-indexed shape the
 * single-table helpers in `lib/export.ts` take.
 *
 * Widening `rows` to `ReportRow[]` is free for anything that only ever *writes*
 * a section, but a page that hands `section.rows` straight to `ExportMenu` is
 * reading one, and a toned row is not a `Record<string, string | number>`. This
 * is the one-word fix for that call site, and it keeps the flattening rules
 * (rich cell → its main line, detail lines dropped) in the same place as the
 * CSV and Excel renderers rather than restated per page.
 */
export function toPlainRows(section: ReportTableSection): Record<string, string | number>[] {
  return sectionRows(section).map((row) => {
    const cells = rowCells(row);
    return Object.fromEntries(section.columns.map((col) => [col.key, cell(cells[col.key])]));
  });
}

// ── CSV — one file, sections stacked with title separators ──
export function exportReportToCsv(doc: ReportDocument, filename: string): void {
  const blocks: string[] = [];
  blocks.push(Papa.unparse([[doc.title]]));
  if (doc.meta && doc.meta.length > 0) {
    blocks.push(Papa.unparse(doc.meta.map((m) => [csvSafeCell(m.label), csvSafeCell(m.value)])));
  }
  for (const section of doc.sections) {
    blocks.push(""); // blank separator line
    if (isTableSection(section)) {
      const header = section.subtitle ? `${section.title} — ${section.subtitle}` : section.title;
      blocks.push(Papa.unparse([[csvSafeCell(header)]]));
      blocks.push(Papa.unparse(csvSafeRows(toHeaderKeyedRows(section))));
    } else if (isNoteSection(section)) {
      const lines = section.title ? [section.title, ...section.lines] : section.lines;
      blocks.push(Papa.unparse(lines.map((line) => [csvSafeCell(line)])));
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
    if (isNoteSection(section)) {
      const aoa = section.title ? [[section.title], []] : [];
      const ws = XLSX.utils.aoa_to_sheet([...aoa, ...section.lines.map((line) => [line])]);
      XLSX.utils.book_append_sheet(wb, ws, uniqueName(section.title ?? "Note"));
      continue;
    }
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

/**
 * The report tones, restated locally for the same reason `KPI_TONE_HEX` is:
 * `components/programs/ProgramCompliance.tsx` owns the on-screen definition of
 * amber-versus-red but is a `"use client"` module, and importing it here would
 * drag React into an export library. These mirror its Tailwind 700-on-50 pairs.
 *
 * Note the brand colour is deliberately absent. The configurable brand ramp
 * re-tints the blue palette in `globals.css`; the PDF palette stays stock, as
 * the in-app help and CLAUDE.md both say — a report mailed on from a
 * white-labelled install should still read as a report.
 */
const TONE_TEXT: Record<ReportTone, string> = {
  red: "#b91c1c",
  amber: "#b45309",
  green: "#15803d",
  muted: "#6b7280",
  neutral: "#111827",
};

/** `null` means "leave the cell unfilled", not "fill it white". */
const TONE_FILL: Record<ReportTone, string | null> = {
  red: "#fef2f2",
  amber: "#fffbeb",
  green: "#f0fdf4",
  muted: null,
  neutral: null,
};

/** A group heading band: slate-50 behind near-black bold text. */
const GROUP_FILL = "#f8fafc";
const GROUP_TEXT = "#0f172a";
/** Secondary lines — group subtitles, notes, row detail, the `sub` of a rich cell. */
const SUBTLE_TEXT = "#6b7280";
/** An untoned note panel still needs *some* fill or its border floats unsupported. */
const NOTE_NEUTRAL_FILL = "#f9fafb";

const BODY_FONT_SIZE = 8;
const SUB_FONT_SIZE = 6.5;
const SMALL_FONT_SIZE = 7;
/**
 * jsPDF draws the first line of a block `fontSize * (2 - 1.15)` below the block's
 * top edge and each subsequent line a `lineHeightFactor` multiple further down.
 * Both constants are baked into jspdf-autotable's own `autoTableText`, so any
 * text we draw *into* a cell has to use the same arithmetic or it will not sit
 * on the same grid as the text autoTable drew.
 */
const FIRST_BASELINE_FACTOR = 2 - 1.15;

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Blend two hex colours, used to derive a note panel's border from its fill. */
function mixRgb(a: string, b: string, t: number): [number, number, number] {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return [
    Math.round(ar + (br - ar) * t),
    Math.round(ag + (bg - ag) * t),
    Math.round(ab + (bb - ab) * t),
  ];
}

/**
 * What a rich cell needs drawn by hand after autoTable has drawn its main
 * line(s). Keyed by the autoTable `Cell` instance, which is the only identity
 * shared between the parse hook (where we know the cell is rich) and the draw
 * hook (where we finally know its box).
 */
interface SubLinePlan {
  lines: string[];
  /** How many lines of the main text precede them, once wrapped to the real width. */
  mainLines: number;
}

export function exportReportToPdf(doc: ReportDocument, filename: string): void {
  // The PDF may be told to draw a different set of sections from the one the
  // data formats read, so every measurement below — orientation included — has
  // to be taken from the sections actually being drawn.
  const sections = doc.pdfSections ?? doc.sections;

  const widestCols = sections.reduce(
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
  const hasWideImage = sections.some(
    (s) => s.kind === "image" && s.images.some((img) => (img.aspectRatio ?? 2) >= 2.2)
  );
  const hasImageBand = sections.some((s) => s.kind === "image" && s.images.length >= 2);
  const landscape = doc.orientation
    ? doc.orientation === "landscape"
    : widestCols > 6 || hasImageBand || (widestCols === 0 && hasWideImage);
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
   *
   * The marker is appended *after* `pdfSafe` and stays a literal U+2026 on
   * purpose. jsPDF's standard fonts are `/WinAnsiEncoding`, i.e. CP1252 rather
   * than ISO-8859-1, and CP1252 defines `…` at 0x85 — jsPDF encodes it
   * correctly. Re-running the result through `pdfSafe` would turn one glyph
   * into three dots and, because `...` is the wider of the two, would also move
   * where the text gets cut.
   */
  const fitLine = (text: string, width: number): string => {
    const lines = pdf.splitTextToSize(pdfSafe(text), width) as string[];
    if (lines.length <= 1) return lines[0] ?? "";
    return `${lines[0].replace(/\s+$/, "")}…`;
  };

  /** Wrap at a given size without disturbing the caller's font state for long. */
  const wrapAt = (text: string, width: number, fontSize: number): string[] => {
    const previous = pdf.getFontSize();
    pdf.setFontSize(fontSize);
    const lines = pdf.splitTextToSize(pdfSafe(text), width) as string[];
    pdf.setFontSize(previous);
    return lines;
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

  /**
   * The heading above a section. `badge` and `lead` are additive: with neither
   * set this runs exactly the two statements it always has, which is what keeps
   * the existing reports' `y` arithmetic (and therefore their pagination)
   * identical.
   */
  const drawHeading = (
    title: string,
    subtitle?: string,
    lead?: string,
    badge?: string,
    badgeTone?: ReportTone,
  ) => {
    pdf.setFontSize(12);
    pdf.text(pdfSafe(title), margin, y);
    if (badge) {
      pdf.setFontSize(9);
      if (badgeTone) pdf.setTextColor(...hexToRgb(TONE_TEXT[badgeTone]));
      else pdf.setTextColor(107);
      // Held to a third of the width so a long badge cannot collide with a long
      // title; the title is the thing a reader scans for.
      pdf.text(fitLine(badge, contentWidth / 3), pageWidth - margin, y, { align: "right" });
      pdf.setTextColor(0);
    }
    y += 5;
    if (subtitle) {
      pdf.setFontSize(8);
      pdf.setTextColor(120);
      pdf.text(pdfSafe(subtitle), margin, y);
      pdf.setTextColor(0);
      y += 5;
    }
    if (lead) {
      pdf.setFontSize(8);
      pdf.setTextColor(90);
      for (const line of pdf.splitTextToSize(pdfSafe(lead), contentWidth) as string[]) {
        pdf.text(line, margin, y);
        y += 4;
      }
      pdf.setTextColor(0);
      y += 1;
    }
  };

  // ── Table sections ──

  /**
   * Everything a body row needs from the hooks. A `null` entry marks a row we
   * built ourselves out of `CellDef`s (a group heading, a subtitle, a note, a
   * detail line) — those carry their styles inline and must be left alone.
   */
  type RowPlan = { tone?: ReportTone; cells: (ReportRichCell | null)[] } | null;

  const drawTableSection = (section: ReportTableSection) => {
    const columns = section.columns;
    const columnCount = columns.length;
    const groups = section.groups ?? [];
    // `groups` is the richer presentation of the same data, so when it is
    // present the flat rows are the CSV/Excel shape and the PDF ignores them.
    const flatRows = groups.length > 0 ? [] : section.rows;
    const isEmpty = groups.length === 0 && flatRows.length === 0;

    const leadLines = section.lead ? wrapAt(section.lead, contentWidth, 8) : [];
    ensureSpace(16 + leadLines.length * 4);
    drawHeading(section.title, section.subtitle, section.lead, section.badge, section.badgeTone);

    if (isEmpty && section.emptyText) {
      pdf.setFontSize(8);
      pdf.setFont("helvetica", "italic");
      pdf.setTextColor(...hexToRgb(SUBTLE_TEXT));
      for (const line of pdf.splitTextToSize(pdfSafe(section.emptyText), contentWidth) as string[]) {
        pdf.text(line, margin, y + 2);
        y += 4;
      }
      pdf.setFont("helvetica", "normal");
      pdf.setTextColor(0);
      y += 6;
      return;
    }

    const body: RowInput[] = [];
    const plans: RowPlan[] = [];

    /** A full-width line of small italic grey text, used for every annotation. */
    const annotationRow = (text: string, opts?: { fill?: string; indent?: number }): CellDef[] => [
      {
        content: pdfSafe(text),
        colSpan: columnCount,
        styles: {
          fontStyle: "italic",
          fontSize: SMALL_FONT_SIZE,
          textColor: hexToRgb(SUBTLE_TEXT),
          fillColor: opts?.fill ? hexToRgb(opts.fill) : false,
          cellPadding: { top: 1, bottom: 1, left: 2 + (opts?.indent ?? 0), right: 2 },
        },
      },
    ];

    const pushRow = (row: ReportRow) => {
      const cells = rowCells(row);
      const values = columns.map((c) => cells[c.key]);
      body.push(columns.map((c, i) => pdfSafe(String(cell(values[i])))));
      plans.push({
        tone: isTonedRow(row) ? row.tone : undefined,
        cells: values.map((v) => (v != null && isRichCell(v) ? v : null)),
      });
      if (isTonedRow(row) && row.detail) {
        for (const line of row.detail) {
          body.push(annotationRow(line, { indent: 4 }));
          plans.push(null);
        }
      }
    };

    for (const row of flatRows) pushRow(row);

    for (const group of groups) {
      // The heading is an ordinary body row rather than a drawn band, which is
      // what stops it being orphaned at the foot of a page: autoTable never
      // splits a single row, and it repaginates the rows after it for us.
      const headingStyles: Partial<Styles> = {
        fontStyle: "bold",
        fontSize: 9,
        textColor: hexToRgb(GROUP_TEXT),
        fillColor: hexToRgb(GROUP_FILL),
      };
      if (group.badge && columnCount > 1) {
        body.push([
          { content: pdfSafe(group.title), colSpan: columnCount - 1, styles: headingStyles },
          {
            content: pdfSafe(group.badge),
            styles: {
              ...headingStyles,
              halign: "right",
              fontSize: SMALL_FONT_SIZE,
              textColor: hexToRgb(TONE_TEXT[group.badgeTone ?? "muted"]),
            },
          },
        ]);
      } else {
        // One column, or no badge: a single band reads better than an empty cell
        // beside the title, so the badge (if any) joins the title.
        const title = group.badge ? `${group.title} — ${group.badge}` : group.title;
        body.push([{ content: pdfSafe(title), colSpan: columnCount, styles: headingStyles }]);
      }
      plans.push(null);

      if (group.subtitle) {
        // Filled to match the heading above it, so the two read as one band.
        body.push(annotationRow(group.subtitle, { fill: GROUP_FILL }));
        plans.push(null);
      }
      for (const row of group.rows) pushRow(row);
      if (group.note) {
        body.push(annotationRow(group.note));
        plans.push(null);
      }
    }

    // ── Column widths ──
    const declaresWidth = columns.some((c) => c.width !== undefined);
    const declaresAlign = columns.some((c) => c.align !== undefined);
    let columnStyles: Record<number, Partial<Styles>> | undefined;
    if (declaresWidth || declaresAlign) {
      const weights = columns.map((c) => (c.width && c.width > 0 ? c.width : 1));
      const total = weights.reduce((a, b) => a + b, 0);
      const styles: Record<number, Partial<Styles>> = {};
      columns.forEach((c, i) => {
        const style: Partial<Styles> = {};
        if (declaresWidth) style.cellWidth = (weights[i] / total) * contentWidth;
        if (c.align) style.halign = c.align;
        styles[i] = style;
      });
      columnStyles = styles;
    }

    const needsCellHooks = plans.some(
      (p) => p !== null && (p.tone !== undefined || p.cells.some((c) => c !== null))
    );

    // Built up conditionally so that a section declaring none of the new fields
    // hands autoTable the same six keys it always has. An unused `didParseCell`
    // is not free: its mere presence changes nothing visible, but "nothing
    // visible" is not the promise made to the thirteen reports that predate it.
    const options: UserOptions = {
      head: [columns.map((c) => pdfSafe(c.header))],
      body,
      startY: y + 1,
      margin: { left: margin, right: margin },
      styles: { fontSize: BODY_FONT_SIZE, cellPadding: 2 },
      headStyles: { fillColor: [51, 51, 51] },
    };
    if (columnStyles) options.columnStyles = columnStyles;

    if (needsCellHooks) {
      const subPlans = new WeakMap<Cell, SubLinePlan>();

      options.didParseCell = (data) => {
        if (data.section !== "body") return;
        const plan = plans[data.row.index];
        if (!plan) return;

        const rowFill = plan.tone ? TONE_FILL[plan.tone] : null;
        if (plan.tone) {
          data.cell.styles.textColor = hexToRgb(TONE_TEXT[plan.tone]);
          if (rowFill) data.cell.styles.fillColor = hexToRgb(rowFill);
        }

        const rich = plan.cells[data.column.index];
        if (!rich) return;
        if (rich.tone) {
          // An explicit cell tone wins over the row's, but a tone with no fill
          // (muted, neutral) only recolours the text — it must not punch a white
          // hole in a tinted row.
          data.cell.styles.textColor = hexToRgb(TONE_TEXT[rich.tone]);
          const cellFill = TONE_FILL[rich.tone];
          if (cellFill) data.cell.styles.fillColor = hexToRgb(cellFill);
        }
        if (rich.bold) data.cell.styles.fontStyle = "bold";
        if (rich.align) data.cell.styles.halign = rich.align;
        if (!rich.sub) return;

        /**
         * Reserving room for the second line is the awkward part: the cell's
         * width is not known until after this hook has run, so we cannot wrap
         * the main text here and therefore cannot say how tall the cell must be.
         *
         * `styles.overflow` accepts a function, and autoTable calls it during
         * layout with the *final* inner width — the one place that knows both.
         * So we take over wrapping for this cell, return the wrapped main lines
         * followed by one blank line per wrapped `sub` line, and let autoTable
         * size the row off that line count. The blanks draw no ink; we paint the
         * sub text into them in `didDrawCell`. Setting `cell.text = []` and
         * drawing everything by hand would leave the column with no content to
         * be measured against and collapse it to its padding.
         */
        const cellObj = data.cell;
        const fontSize = cellObj.styles.fontSize;
        cellObj.styles.overflow = (text, width) => {
          const raw = Array.isArray(text) ? text : [text];
          const mainLines = raw.flatMap(
            (line) =>
              pdf.splitTextToSize(line, width + 1 / pdf.internal.scaleFactor, {
                fontSize,
              }) as string[]
          );
          const subLines = pdf.splitTextToSize(pdfSafe(rich.sub ?? ""), width, {
            fontSize: SUB_FONT_SIZE,
          }) as string[];
          subPlans.set(cellObj, { lines: subLines, mainLines: mainLines.length });
          return [...mainLines, ...subLines.map(() => "")];
        };
      };

      options.didDrawCell = (data) => {
        if (data.section !== "body") return;
        const plan = subPlans.get(data.cell);
        if (!plan || plan.lines.length === 0) return;

        const cellObj = data.cell;
        const styles = cellObj.styles;
        const scale = pdf.internal.scaleFactor;
        const bodyLine = (styles.fontSize / scale) * pdf.getLineHeightFactor();
        const subSize = SUB_FONT_SIZE / scale;

        // Where autoTable put the top of the text block, mirroring `getTextPos`
        // and `autoTableText`: `valign` decides the block's top edge, and the
        // first baseline sits `fontSize * 0.85` below it.
        const lineCount = cellObj.text.length;
        const blockTop =
          styles.valign === "bottom"
            ? cellObj.y + cellObj.height - cellObj.padding("bottom") - lineCount * bodyLine
            : styles.valign === "middle"
              ? cellObj.y +
                (cellObj.height - cellObj.padding("vertical")) / 2 +
                cellObj.padding("top") -
                (lineCount / 2) * bodyLine
              : cellObj.y + cellObj.padding("top");

        const align = styles.halign === "center" || styles.halign === "right" ? styles.halign : "left";
        const x =
          align === "right"
            ? cellObj.x + cellObj.width - cellObj.padding("right")
            : align === "center"
              ? cellObj.x + (cellObj.width - cellObj.padding("horizontal")) / 2 + cellObj.padding("left")
              : cellObj.x + cellObj.padding("left");

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(SUB_FONT_SIZE);
        pdf.setTextColor(...hexToRgb(SUBTLE_TEXT));
        plan.lines.forEach((line, i) => {
          const slotTop = blockTop + (plan.mainLines + i) * bodyLine;
          pdf.text(line, x, slotTop + subSize * FIRST_BASELINE_FACTOR, { align });
        });
        // autoTable re-applies the next cell's styles before drawing it, but the
        // last cell of the last table would otherwise leave 6.5pt grey behind for
        // whatever we draw next.
        pdf.setTextColor(0);
        pdf.setFontSize(BODY_FONT_SIZE);
      };
    }

    autoTable(pdf, options);
    // jspdf-autotable stashes the last table's end Y on the doc instance.
    y = (pdf as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;
    y += 8;
  };

  // ── Note sections — a tinted panel, measured before it is drawn ──
  const drawNoteSection = (section: ReportNoteSection) => {
    const tone = section.tone ?? "neutral";
    const pad = 3;
    const innerWidth = contentWidth - pad * 2;
    const titleHeight = section.title ? 5 : 0;
    const lines = section.lines.flatMap((line) => wrapAt(line, innerWidth, 8));
    const height = pad * 2 + titleHeight + lines.length * 4;

    // One reservation for the whole panel. `ensureSpace` breaks at most once, so
    // a panel taller than a page simply flows off the bottom rather than looping.
    ensureSpace(height + 4);

    const fill = TONE_FILL[tone] ?? NOTE_NEUTRAL_FILL;
    pdf.setFillColor(...hexToRgb(fill));
    pdf.setDrawColor(...mixRgb(fill, TONE_TEXT[tone], 0.25));
    pdf.setLineWidth(0.2);
    pdf.roundedRect(margin, y, contentWidth, height, 1.5, 1.5, "FD");

    let textY = y + pad;
    if (section.title) {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      pdf.setTextColor(...hexToRgb(TONE_TEXT[tone]));
      pdf.text(pdfSafe(section.title), margin + pad, textY + 3);
      pdf.setFont("helvetica", "normal");
      textY += titleHeight;
    }
    pdf.setFontSize(8);
    pdf.setTextColor(...hexToRgb(TONE_TEXT[tone]));
    for (const line of lines) {
      pdf.text(line, margin + pad, textY + 3);
      textY += 4;
    }
    pdf.setTextColor(0);
    y += height + 6;
  };

  for (const section of sections) {
    if (isTableSection(section)) {
      drawTableSection(section);
    } else if (isNoteSection(section)) {
      drawNoteSection(section);
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
  columns: { key: string; header: string; width?: number; align?: "left" | "center" | "right" }[];
  rows: ReportRow[];
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
