"use client";

/**
 * Rasterise a live Recharts chart into a PNG data URL, so report exports can
 * embed the charts a user is looking at.
 *
 * Recharts draws SVG into the DOM, and an SVG only becomes an image by being
 * serialised, loaded through an `<img>`, and painted onto a canvas. That round
 * trip is lossy in two specific ways, and most of this module exists to undo
 * them:
 *
 *  1. The serialised document is isolated — it inherits nothing from the page's
 *     stylesheets — so anything Recharts left to CSS (above all the font on
 *     every `<text>`) has to be inlined onto the clone first.
 *  2. `<Legend>` is rendered as HTML *outside* the chart's `<svg>`, so it is not
 *     serialised at all. We read the entries back out of the DOM and redraw
 *     them onto the canvas.
 *
 * Nothing here throws. A chart that cannot be captured is omitted from the
 * export rather than costing the user the data table they actually asked for.
 */

export interface CapturedChart {
  title: string;
  /** PNG data URL. */
  dataUrl: string;
  /** Measured width / height of the finished canvas, used to size the PDF image. */
  aspectRatio: number;
  /** Index of the on-screen row this card sits in; charts sharing one are drawn side by side. */
  row: number;
  /** This card's share of its row's width, so a 2:1 pair stays 2:1 in the PDF. */
  widthFraction: number;
}

/**
 * Matches the app's `body` font (globals.css). Forced rather than copied: the
 * isolated document cannot fetch `@font-face` resources, so if a webfont is
 * ever added to the app a copied value would silently fall back to Times inside
 * the raster. It also matches jsPDF's default Helvetica, so chart text and PDF
 * body text look like one document.
 */
const SAFE_FONT = "Arial, Helvetica, sans-serif";

/**
 * Copied from the live tree onto the clone. Deliberately short — copying all
 * ~340 computed properties per node balloons the serialised SVG into megabytes
 * and is slow on a chart with several hundred nodes.
 *
 * Not listed, on purpose:
 *  - `clip-path` / `mask` / `filter`: `getComputedStyle` absolutises paint
 *    servers to `url("http://host/page#id")` in some engines, which cannot
 *    resolve inside a `data:` document. Recharts' own `clip-path` *attribute*
 *    survives `cloneNode` untouched and resolves fine.
 *  - `visibility` / `display`: both can blank the raster, and we never need
 *    them — a zero-sized chart is rejected before we get here.
 */
const INLINE_PROPS = [
  "font-family", "font-size", "font-weight", "font-style", "letter-spacing",
  "text-anchor", "dominant-baseline", "paint-order",
  "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-opacity", "stroke-width",
  "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin",
  "opacity",
] as const;

/** Legend layout, in CSS px. */
const SWATCH = 10;
const SWATCH_GAP = 6;
const ITEM_GAP = 18;
const LINE_H = 18;
const PAD_TOP = 6;
const PAD_X = 8;
const LEGEND_FONT = `12px ${SAFE_FONT}`;
const LEGEND_TEXT = "#374151";

interface LegendEntry {
  label: string;
  color: string;
}

/**
 * The chart's own `<svg>`, or null when this card is currently showing an empty
 * state instead of a chart (several reports do).
 *
 * Recharts gives each legend swatch its own `svg.recharts-surface` too, so a
 * bare `querySelector` can return a 14x14 icon instead of the chart.
 */
function findSurface(card: HTMLElement): SVGSVGElement | null {
  const tagged = Array.from(card.querySelectorAll<SVGSVGElement>("svg.recharts-surface"));
  const candidates = tagged.length > 0 ? tagged : Array.from(card.querySelectorAll<SVGSVGElement>("svg"));
  const main = candidates.find((s) => !s.closest(".recharts-legend-wrapper"));
  if (!main) return null;
  const rect = main.getBoundingClientRect();
  // Guards an unlaid-out or hidden chart, and any legend icon that slipped through.
  return rect.width >= 2 && rect.height >= 2 ? main : null;
}

/**
 * Copy the whitelisted computed styles from the live tree onto the detached
 * clone. `cloneNode(true)` preserves structure exactly, so the two trees are
 * index-parallel in document order; we verify that rather than assume it.
 *
 * All reads are from the live tree and all writes are to the detached clone, so
 * this costs one style recalculation rather than thrashing layout per node.
 */
function inlineStyles(live: Element, clone: Element): void {
  const liveNodes: Element[] = [live, ...Array.from(live.querySelectorAll("*"))];
  const cloneNodes: Element[] = [clone, ...Array.from(clone.querySelectorAll("*"))];
  if (liveNodes.length !== cloneNodes.length) return; // degrade to presentation attributes

  for (let i = 0; i < liveNodes.length; i++) {
    const cs = window.getComputedStyle(liveNodes[i]);
    let decl = "";
    for (const prop of INLINE_PROPS) {
      let value = cs.getPropertyValue(prop);
      if (!value) continue;
      if (value.startsWith("url(")) continue; // see INLINE_PROPS note
      if (prop === "font-family") value = SAFE_FONT;
      decl += `${prop}:${value};`;
    }
    if (decl) cloneNodes[i].setAttribute("style", decl);
  }
}

/** Read the legend entries Recharts rendered as HTML alongside the chart. */
function readLegend(card: HTMLElement): LegendEntry[] {
  const wrapper = card.querySelector<HTMLElement>(".recharts-legend-wrapper");
  if (!wrapper) return [];
  return Array.from(wrapper.querySelectorAll<HTMLElement>(".recharts-legend-item"))
    .map((item) => {
      const label = (
        item.querySelector(".recharts-legend-item-text")?.textContent ?? item.textContent ?? ""
      ).trim();
      const icon =
        item.querySelector<SVGElement>(".recharts-legend-icon") ??
        item.querySelector<SVGElement>("path,line,rect,circle");
      let color = "#6b7280";
      if (icon) {
        const cs = window.getComputedStyle(icon);
        const fill = cs.getPropertyValue("fill");
        const stroke = cs.getPropertyValue("stroke");
        // Bar/Area/Pie icons carry the colour on fill; Line icons carry it on stroke.
        if (fill && fill !== "none") color = fill;
        else if (stroke && stroke !== "none") color = stroke;
      }
      return { label, color };
    })
    .filter((entry) => entry.label.length > 0);
}

/**
 * Wrap the legend into lines that fit `width`. Measured up front because the
 * canvas height must be known before `canvas.height` is assigned — assigning it
 * clears the bitmap and resets the context.
 */
function layoutLegend(entries: LegendEntry[], width: number): { lines: LegendEntry[][]; height: number } {
  if (entries.length === 0) return { lines: [], height: 0 };
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) return { lines: [], height: 0 };
  measure.font = LEGEND_FONT;
  const available = width - PAD_X * 2;

  const lines: LegendEntry[][] = [];
  let line: LegendEntry[] = [];
  let used = 0;
  for (const entry of entries) {
    const w = SWATCH + SWATCH_GAP + measure.measureText(entry.label).width;
    if (line.length > 0 && used + ITEM_GAP + w > available) {
      lines.push(line);
      line = [];
      used = 0;
    }
    used += (line.length > 0 ? ITEM_GAP : 0) + w;
    line.push(entry);
  }
  if (line.length > 0) lines.push(line);
  return { lines, height: PAD_TOP + lines.length * LINE_H + 4 };
}

/** Shorten a label that alone overflows the available width. */
function ellipsize(ctx: CanvasRenderingContext2D, label: string, max: number): string {
  if (ctx.measureText(label).width <= max) return label;
  let lo = 0;
  let hi = label.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${label.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${label.slice(0, lo)}…`;
}

function drawLegend(
  ctx: CanvasRenderingContext2D,
  lines: LegendEntry[][],
  width: number,
  top: number
): void {
  ctx.font = LEGEND_FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const available = width - PAD_X * 2;

  lines.forEach((line, lineIndex) => {
    const labels = line.map((e) => ellipsize(ctx, e.label, available - SWATCH - SWATCH_GAP));
    const widths = labels.map((l) => SWATCH + SWATCH_GAP + ctx.measureText(l).width);
    const total = widths.reduce((a, b) => a + b, 0) + ITEM_GAP * (line.length - 1);
    let x = Math.max(PAD_X, (width - total) / 2);
    const cy = top + PAD_TOP + lineIndex * LINE_H + LINE_H / 2;

    line.forEach((entry, i) => {
      ctx.fillStyle = entry.color;
      // Plain rect rather than roundRect, which is not universally available.
      ctx.fillRect(x, cy - SWATCH / 2, SWATCH, SWATCH);
      ctx.fillStyle = LEGEND_TEXT;
      ctx.fillText(labels[i], x + SWATCH + SWATCH_GAP, cy);
      x += widths[i] + ITEM_GAP;
    });
  });
}

/** Reject a promise that never settles, so a wedged decode cannot hang an export. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("chart capture timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * Capture one chart card. Returns null — never throws — when the card holds no
 * chart, or when any step of the raster fails.
 */
export async function captureChartCard(
  card: HTMLElement,
  opts?: { title?: string; scale?: number }
): Promise<Omit<CapturedChart, "row" | "widthFraction"> | null> {
  if (typeof window === "undefined") return null;
  try {
    const svg = findSurface(card);
    if (!svg) return null;

    const rect = svg.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    const clone = svg.cloneNode(true) as SVGSVGElement;
    inlineStyles(svg, clone);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);

    // encodeURIComponent, not btoa (throws above U+00FF, and chart labels carry
    // em dashes and ellipses) and not encodeURI (leaves '#' unescaped, which
    // truncates the URL at the first #rrggbb fill).
    const xml = new XMLSerializer().serializeToString(clone);
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;

    const img = new Image();
    img.decoding = "async";
    img.src = svgUrl;
    const ready: Promise<unknown> =
      typeof img.decode === "function"
        ? img.decode()
        : new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("chart image failed to load"));
          });
    await withTimeout(ready, 5000);

    // Recharts reserves the legend's space by shrinking the plot area, but the
    // surface still spans the full container height — so the bottom of the
    // serialised SVG is an empty band exactly where the legend sits. Crop it,
    // then draw our own legend there. If this is ever wrong the cost is a
    // cosmetic blank band, not a broken export.
    const legendWrapper = card.querySelector<HTMLElement>(".recharts-legend-wrapper");
    const reserved = legendWrapper ? Math.round(legendWrapper.getBoundingClientRect().height) : 0;
    const plotHeight = Math.max(1, height - reserved);

    const legend = layoutLegend(readLegend(card), width);
    const totalHeight = plotHeight + legend.height;

    const scale = Math.min(Math.max(opts?.scale ?? window.devicePixelRatio ?? 1, 2), 3);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(totalHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(scale, scale);

    // White first: the SVG is transparent, and jsPDF composites alpha-0 pixels
    // as black in several viewers — a chart on a solid black block.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, totalHeight);
    // Drawn at natural height; the clipped remainder is the blank legend band.
    ctx.drawImage(img, 0, 0, width, height);
    drawLegend(ctx, legend.lines, width, plotHeight);

    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL("image/png");
    } catch {
      // Tainting cannot happen today (data: source, no external <image>, no
      // <foreignObject>), but a SecurityError is the one failure that would
      // otherwise escape as a throw.
      return null;
    }

    const title =
      opts?.title ??
      card.getAttribute("data-chart-title") ??
      card.querySelector("h3")?.textContent?.trim() ??
      "Chart";

    return { title, dataUrl, aspectRatio: width / totalHeight };
  } catch {
    return null;
  }
}

/**
 * Which cards share a row on screen, and how wide each is within it.
 *
 * This is what lets a PDF reproduce the page's chart layout: two cards side by
 * side stay side by side, a card that spans the width keeps it, and a 2:1 pair
 * (a wide chart beside a donut) keeps its proportions. Deriving it from the
 * rendered geometry rather than from per-page configuration means a report only
 * has to lay its charts out once, in CSS.
 *
 * Two cards are on the same row when their vertical extents overlap by more
 * than half the shorter one — tolerant of the few pixels' difference between
 * cards of unequal height in one grid row, and never true of stacked cards.
 * A narrow window in which the grid has collapsed to one column therefore
 * reports one card per row, which is exactly what the exporter should draw:
 * the PDF matches whatever the person exporting it is looking at.
 */
function layoutRows(cards: HTMLElement[]): { row: number; widthFraction: number }[] {
  const rects = cards.map((card) => card.getBoundingClientRect());
  const rows: number[] = [];
  let row = 0;
  rects.forEach((rect, i) => {
    if (i > 0) {
      const previous = rects[i - 1];
      const overlap = Math.min(previous.bottom, rect.bottom) - Math.max(previous.top, rect.top);
      if (overlap < Math.min(previous.height, rect.height) / 2) row += 1;
    }
    rows.push(row);
  });

  const rowWidth = new Map<number, number>();
  rows.forEach((r, i) => rowWidth.set(r, (rowWidth.get(r) ?? 0) + rects[i].width));
  return rows.map((r, i) => ({
    row: r,
    widthFraction: rects[i].width / (rowWidth.get(r) || rects[i].width || 1),
  }));
}

/**
 * Capture several cards, skipping any that fail.
 *
 * Sequential rather than `Promise.all` on purpose: each capture allocates a
 * canvas of a few megapixels, and decoding several large SVGs at once is where
 * mobile Safari runs out of memory and quietly hands back a blank image.
 */
export async function captureCharts(
  cards: HTMLElement[],
  opts?: { scale?: number }
): Promise<CapturedChart[]> {
  // Measured up front, in one pass, before any canvas work perturbs layout.
  const layout = layoutRows(cards);
  const captured: CapturedChart[] = [];
  for (let i = 0; i < cards.length; i++) {
    const shot = await captureChartCard(cards[i], opts);
    if (shot) captured.push({ ...shot, ...layout[i] });
  }
  return captured;
}
