"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useChartTheme } from "@/lib/chart-theme";

/**
 * A data-agnostic, ISO-keyed world choropleth.
 *
 * Nothing here knows about offerings, programs or reports: a consumer hands it
 * one datum per ISO 3166-1 alpha-2 code and gets a map, a legend and an honest
 * account of what it could not draw.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A PLAIN INLINE SVG, AND WHAT THAT FORBIDS
 *
 * Report PDFs embed the charts the user is looking at by rasterising them
 * (`src/lib/chart-capture.ts`). `findSurface` falls back to *any* `<svg>` inside
 * the card when there is no `.recharts-surface`, so an inline SVG is captured for
 * free — while a canvas or WebGL map captures as `null`, and every failure path
 * there returns null by design, so the map would be silently missing from every
 * export. That single fact drives four rules, all of them load-bearing:
 *
 *  1. **Flat per-path `fill` only.** `inlineStyles` skips any computed value
 *     beginning with `url(`, so a gradient or pattern fill captures as nothing.
 *  2. **No `clip-path`, `mask` or `filter`.** They are deliberately absent from
 *     that module's `INLINE_PROPS` because their computed forms absolutise to
 *     URLs that cannot resolve inside a `data:` document. Geometry that runs off
 *     the side of the map is cropped by the root `<svg>`'s own viewBox instead,
 *     which is intrinsic overflow and needs no clip path.
 *  3. **The legend is drawn inside the `<svg>`.** The capture's legend redraw
 *     reads `.recharts-legend-item`, an HTML node only Recharts emits, so an HTML
 *     legend beside the map would simply be absent from the PDF.
 *  4. **This component must contain no other `<svg>`.** `findSurface` takes the
 *     first `<svg>` in the card, so an icon rendered above the map would be
 *     captured in its place. The notice below uses text, not an icon, for that
 *     reason.
 *
 * Fills are resolved **at render**, never inside the memoised geometry. A
 * theme-dependent colour living in a memoised array changes that array's identity
 * when `ForceLightChartsContext` flips for a capture, and an identity change is
 * what restarts an animation and gets a half-drawn chart photographed. Memoise
 * geometry; resolve colour in the JSX.
 * ---------------------------------------------------------------------------
 */

export interface GeoMapDatum {
  /** ISO 3166-1 alpha-2, uppercase. The join key. */
  iso: string;
  /** Display label(s) — the app's own country name(s), not the atlas's. */
  labels: string[];
  /** Drives the fill in "sequential" mode. null = no data, which is NOT zero. */
  value: number | null;
  /** Discrete band, for "categorical" mode. */
  band?: string;
}

export interface GeoMapProps {
  data: GeoMapDatum[];
  mode: "sequential" | "categorical";
  /** Categorical fills + legend. Ignored in sequential mode. */
  bands?: { key: string; label: string; color: string }[];
  /** Sequential legend title, e.g. "Active holders". */
  valueLabel?: string;
  /** Countries in RegionData with no isoCode. Rendered by the component. */
  unmapped?: string[];
  /** Emits both the code and the app's country name. */
  onSelect?: (iso: string, labels: string[]) => void;
  selected?: string | null;
  height?: number;
}

/** The static asset in `public/geo/`. See `public/geo/README.md`. */
interface GeoAtlas {
  viewBox: string;
  paths: Record<string, string>;
  unclaimed?: string[];
  enlarged?: string[];
}

const ATLAS_URL = "/geo/world-countries.json";

/**
 * The only thing that may be treated as an ISO code.
 *
 * `RegionData.isoCode` is operator-entered and rows can predate the database
 * CHECK, so every code arriving here — from the data, from `selected`, and from
 * the atlas file itself — is untrusted text until it matches. It is never
 * interpolated into an element id or a DOM selector either; it is only ever a Map
 * key and a React key, both of which are inert.
 */
const ISO_RE = /^[A-Z]{2}$/;

/**
 * Sequential ramp: step 0 is the value zero, steps 1-4 are the quantile bins.
 *
 * `useChartTheme` carries a categorical palette and a status pair but no
 * sequential ramp, so these live here — keyed off its `isDark` rather than off
 * `useTheme` directly, which is what makes `ForceLightChartsContext` flip this
 * map to the light palette for a PDF capture exactly as it does every Recharts
 * card. If a second map consumer wants the same ramp, move it into
 * `lib/chart-theme.ts` rather than copying it.
 *
 * "No data" is deliberately a neutral GREY, not a step of the ramp: it is outside
 * the scale rather than at the bottom of it, and it has to be told apart from
 * zero at a glance.
 */
const RAMP_LIGHT = ["#eff6ff", "#bfdbfe", "#60a5fa", "#2563eb", "#1e3a8a"];
const RAMP_DARK = ["#1e293b", "#1e40af", "#2563eb", "#60a5fa", "#bfdbfe"];
const NO_DATA_LIGHT = "#d1d5db";
const NO_DATA_DARK = "#4b5563";

/** Layout constants, in atlas viewBox units. At a 2000-unit width they render ~12px. */
const FONT = 26;
const SWATCH = 30;
const SWATCH_GAP = 10;
const ITEM_GAP = 46;
const ROW_H = 44;
const LEGEND_TOP = 18;
const SIDE_PAD = 8;
/** No text metrics inside an SVG; this over-estimates slightly, which wraps early. */
const CHAR_W = FONT * 0.56;

interface Aggregated {
  iso: string;
  labels: string[];
  value: number | null;
  band?: string;
}

interface LegendItem {
  label: string;
  color: string;
}

/**
 * Fold the rows to one entry per ISO.
 *
 * `RegionData.isoCode` is deliberately not unique — a sales geography may carry
 * "England" and "Scotland" as separate countries, both `GB` — so several rows can
 * land on one shape. Summing the values and keeping every contributing name is
 * the only reading that does not quietly drop one of them.
 *
 * `null` is absence, not zero, so it never contributes to a sum: one row with no
 * data alongside one with five holders is five, and an ISO whose every row is
 * null stays null.
 */
function aggregate(data: GeoMapDatum[]): Map<string, Aggregated> {
  const out = new Map<string, Aggregated>();
  for (const datum of data) {
    if (!ISO_RE.test(datum.iso)) continue;
    const existing = out.get(datum.iso);
    if (!existing) {
      out.set(datum.iso, {
        iso: datum.iso,
        labels: [...datum.labels],
        value: datum.value,
        band: datum.band,
      });
      continue;
    }
    for (const label of datum.labels) {
      if (!existing.labels.includes(label)) existing.labels.push(label);
    }
    if (datum.value !== null) existing.value = (existing.value ?? 0) + datum.value;
    // First band wins. Two rows sharing an ISO but disagreeing on band is a
    // contradiction the component cannot resolve; it reports the first rather
    // than inventing a blend.
    if (existing.band === undefined) existing.band = datum.band;
  }
  return out;
}

/**
 * Quantile bins over the positive values, so a handful of large countries cannot
 * flatten everything else into one shade — which equal-width bins do on almost
 * every real distribution here. Zero gets its own palest step and is always shown
 * in the legend, because "nobody here" and "we do not know" must not look alike.
 */
function quantileBins(values: number[]): { from: number; to: number }[] {
  const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [];

  // Cut points at the quantile boundaries, collapsed where a repeated value makes
  // two boundaries land on the same number.
  const count = Math.min(4, new Set(positive).size);
  const cuts: number[] = [];
  for (let i = 1; i <= count; i++) {
    const at = Math.min(positive.length - 1, Math.ceil((i / count) * positive.length) - 1);
    const value = positive[at];
    if (cuts.length === 0 || value > cuts[cuts.length - 1]) cuts.push(value);
  }

  const bins: { from: number; to: number }[] = [];
  let lowerExclusive = 0;
  for (const to of cuts) {
    // The smallest observed value above the previous cut, so the legend reads as
    // the data actually is rather than as an invented round number.
    const from = positive.find((v) => v > lowerExclusive) ?? to;
    bins.push({ from, to });
    lowerExclusive = to;
  }
  return bins;
}

function binIndex(bins: { from: number; to: number }[], value: number): number {
  for (let i = 0; i < bins.length; i++) if (value <= bins[i].to) return i;
  return bins.length - 1;
}

/** Wrap legend items into rows that fit the map's width. */
function layoutLegend(items: LegendItem[], width: number): LegendItem[][] {
  const rows: LegendItem[][] = [];
  let row: LegendItem[] = [];
  let used = 0;
  const available = width - SIDE_PAD * 2;
  for (const item of items) {
    const w = SWATCH + SWATCH_GAP + item.label.length * CHAR_W;
    if (row.length > 0 && used + ITEM_GAP + w > available) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += (row.length > 0 ? ITEM_GAP : 0) + w;
    row.push(item);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

export default function GeoMap({
  data,
  mode,
  bands,
  valueLabel,
  unmapped,
  onSelect,
  selected,
  height = 420,
}: GeoMapProps) {
  const theme = useChartTheme();
  const atlas = useFetchJson<GeoAtlas>(ATLAS_URL);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ iso: string; x: number; y: number } | null>(null);
  const [showUnmapped, setShowUnmapped] = useState(false);

  const byIso = useMemo(() => aggregate(data), [data]);

  /**
   * Geometry only — no colour. See the module header: a fill in here would change
   * this array's identity on the palette flip and break the PDF capture.
   */
  const shapes = useMemo(() => {
    const paths = atlas.data?.paths;
    if (!paths) return [];
    // Largest-first order is a property of the asset and the reason small
    // countries stay clickable; preserve it rather than re-sorting.
    return Object.entries(paths)
      .filter(([iso, d]) => ISO_RE.test(iso) && typeof d === "string" && d.length > 0)
      .map(([iso, d]) => ({ iso, d }));
  }, [atlas.data]);

  const viewBox = useMemo(() => {
    const parts = (atlas.data?.viewBox ?? "").split(/\s+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) {
      return null;
    }
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }, [atlas.data]);

  /** Codes the caller gave us that this atlas has no shape for. Reported, not dropped. */
  const undrawable = useMemo(() => {
    if (shapes.length === 0) return [];
    const known = new Set(shapes.map((s) => s.iso));
    return [...byIso.values()].filter((entry) => !known.has(entry.iso)).flatMap((entry) => entry.labels);
  }, [byIso, shapes]);

  /** Countries in view whose outline is too small to draw truthfully. */
  const enlargedInUse = useMemo(() => {
    const enlarged = new Set(atlas.data?.enlarged ?? []);
    return [...byIso.values()]
      .filter((entry) => entry.value !== null || entry.band !== undefined)
      .filter((entry) => enlarged.has(entry.iso))
      .flatMap((entry) => entry.labels);
  }, [byIso, atlas.data]);

  // Every value the caller gave us feeds the scale, including one whose country
  // this atlas cannot draw: the legend describes the data, and the notice below
  // says which of it is missing from the picture. Binning only the drawable rows
  // would make the legend and the table disagree about the same numbers.
  const bins = useMemo(
    () =>
      mode === "sequential"
        ? quantileBins([...byIso.values()].map((e) => e.value).filter((v): v is number => v !== null))
        : [],
    [byIso, mode]
  );

  const select = useCallback(
    (iso: string) => {
      if (!onSelect || !ISO_RE.test(iso)) return;
      onSelect(iso, byIso.get(iso)?.labels ?? []);
    },
    [onSelect, byIso]
  );

  // --- colours, resolved per render so the light-palette flip needs no special case ---
  // `useChartTheme` carries no sequential ramp, so the two ramps above are keyed
  // off its `isDark` rather than off `useTheme` directly. That is what makes
  // `ForceLightChartsContext` work here exactly as it does for every Recharts card.
  const ramp = theme.isDark ? RAMP_DARK : RAMP_LIGHT;
  const noDataFill = theme.isDark ? NO_DATA_DARK : NO_DATA_LIGHT;
  const landStroke = theme.isDark ? "#0f172a" : "#ffffff";
  const selectedStroke = theme.isDark ? "#f8fafc" : "#111827";
  const legendText = theme.isDark ? "#e5e7eb" : "#374151";

  const bandColor = useCallback(
    (key: string | undefined) => bands?.find((b) => b.key === key)?.color,
    [bands]
  );

  const fillFor = (iso: string): string => {
    const entry = byIso.get(iso);
    if (!entry) return noDataFill;
    if (mode === "categorical") return bandColor(entry.band) ?? noDataFill;
    if (entry.value === null) return noDataFill;
    if (entry.value <= 0) return ramp[0];
    return ramp[1 + binIndex(bins, entry.value)] ?? ramp[ramp.length - 1];
  };

  const legendItems: LegendItem[] =
    mode === "categorical"
      ? [...(bands ?? []).map((b) => ({ label: b.label, color: b.color })), { label: "No data", color: noDataFill }]
      : [
          { label: "0", color: ramp[0] },
          ...bins.map((bin, i) => ({
            label: bin.from === bin.to ? `${bin.from}` : `${bin.from}–${bin.to}`,
            color: ramp[1 + i] ?? ramp[ramp.length - 1],
          })),
          { label: "No data", color: noDataFill },
        ];

  const mapWidth = viewBox?.width ?? 0;
  const legendRows = layoutLegend(legendItems, mapWidth);
  const legendTitle = mode === "sequential" && valueLabel ? valueLabel : null;
  const unmappedCount = (unmapped?.length ?? 0) + undrawable.length;
  const legendHeight =
    mapWidth === 0
      ? 0
      : LEGEND_TOP +
        (legendTitle ? ROW_H : 0) +
        legendRows.length * ROW_H +
        (unmappedCount > 0 ? ROW_H : 0) +
        10;

  const hovered = hover ? byIso.get(hover.iso) : null;

  if (atlas.loading) {
    return (
      <div
        className="flex items-center justify-center text-sm text-gray-500"
        style={{ height }}
      >
        Loading map…
      </div>
    );
  }

  if (atlas.error || !viewBox || shapes.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-gray-500" style={{ height }}>
        The map could not be loaded. The figures below are unaffected.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        role="img"
        aria-label="World map"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height + legendHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className="block w-full h-auto"
        style={{ maxHeight: height }}
        onMouseLeave={() => setHover(null)}
      >
        {/* Land with no ISO code. Background only — it can never be coloured or picked. */}
        {(atlas.data?.unclaimed ?? []).map((d, i) => (
          <path
            key={`unclaimed-${i}`}
            d={d}
            fill={noDataFill}
            stroke={landStroke}
            strokeWidth={1}
            pointerEvents="none"
          />
        ))}

        {shapes.map(({ iso, d }) => {
          const entry = byIso.get(iso);
          const interactive = Boolean(onSelect) && entry !== undefined;
          const isSelected = selected === iso && ISO_RE.test(selected ?? "");
          return (
            <path
              key={iso}
              d={d}
              fill={fillFor(iso)}
              stroke={isSelected || hover?.iso === iso ? selectedStroke : landStroke}
              strokeWidth={isSelected ? 6 : hover?.iso === iso ? 3 : 1}
              strokeLinejoin="round"
              cursor={interactive ? "pointer" : undefined}
              tabIndex={interactive ? 0 : undefined}
              role={interactive ? "button" : undefined}
              aria-label={entry ? entry.labels.join(", ") || iso : undefined}
              onPointerMove={(event) => {
                const box = containerRef.current?.getBoundingClientRect();
                if (!box) return;
                setHover({ iso, x: event.clientX - box.left, y: event.clientY - box.top });
              }}
              onPointerLeave={() => setHover((h) => (h?.iso === iso ? null : h))}
              onClick={() => select(iso)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select(iso);
                }
              }}
            />
          );
        })}

        {/* The legend lives in here on purpose — see rule 3 in the module header. */}
        <g transform={`translate(0 ${viewBox.height + LEGEND_TOP})`}>
          {legendTitle ? (
            <text x={SIDE_PAD} y={FONT} fontSize={FONT} fontWeight={600} fill={legendText}>
              {legendTitle}
            </text>
          ) : null}
          {legendRows.map((row, rowIndex) => {
            let x = SIDE_PAD;
            return (
              <g
                key={`legend-row-${rowIndex}`}
                transform={`translate(0 ${(legendTitle ? ROW_H : 0) + rowIndex * ROW_H})`}
              >
                {row.map((item) => {
                  const at = x;
                  x += SWATCH + SWATCH_GAP + item.label.length * CHAR_W + ITEM_GAP;
                  return (
                    <g key={`${item.label}-${at}`}>
                      <rect
                        x={at}
                        y={FONT - SWATCH + 4}
                        width={SWATCH}
                        height={SWATCH}
                        fill={item.color}
                        stroke={landStroke}
                        strokeWidth={1}
                      />
                      <text
                        x={at + SWATCH + SWATCH_GAP}
                        y={FONT}
                        fontSize={FONT}
                        fill={legendText}
                      >
                        {item.label}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
          {unmappedCount > 0 ? (
            <text
              x={SIDE_PAD}
              y={(legendTitle ? ROW_H : 0) + legendRows.length * ROW_H + FONT}
              fontSize={FONT}
              fill={legendText}
            >
              {`${unmappedCount} ${unmappedCount === 1 ? "country is" : "countries are"} not shown on this map.`}
            </text>
          ) : null}
        </g>
      </svg>

      {hovered && hover ? (
        <div
          className="pointer-events-none absolute z-10 rounded-md border px-2 py-1 text-xs shadow-sm"
          style={{
            left: Math.round(hover.x) + 12,
            top: Math.round(hover.y) + 12,
            backgroundColor: theme.tooltipBg,
            borderColor: theme.tooltipBorder,
            color: theme.tooltipText,
          }}
        >
          <div className="font-medium">{hovered.labels.join(", ") || hovered.iso}</div>
          <div>
            {mode === "categorical"
              ? bands?.find((b) => b.key === hovered.band)?.label ?? "No data"
              : hovered.value === null
                ? "No data"
                : `${hovered.value.toLocaleString()}${valueLabel ? ` ${valueLabel.toLowerCase()}` : ""}`}
          </div>
        </div>
      ) : null}

      {/*
        The unmapped notice, rendered by the component so no consumer can forget
        it. Same principle as `PendingReviewNotice`: it reports an ongoing
        inaccuracy in the numbers on the same screen, so it is not dismissible.
        The one-line count is repeated inside the SVG above, which is the only
        part a PDF export carries.
      */}
      {unmappedCount > 0 ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-semibold">
            {unmappedCount} {unmappedCount === 1 ? "country is" : "countries are"} not shown on the
            map
          </p>
          <p className="text-amber-800">
            {(unmapped?.length ?? 0) > 0 ? (
              <>
                {unmapped?.length} {unmapped?.length === 1 ? "has" : "have"} no ISO country code set
                in Region Data.{" "}
              </>
            ) : null}
            {undrawable.length > 0 ? (
              <>
                {undrawable.length} {undrawable.length === 1 ? "has a code" : "have codes"} this map
                has no outline for.{" "}
              </>
            ) : null}
            Their figures are in the table but not in the picture.{" "}
            <button
              type="button"
              className="font-medium underline"
              onClick={() => setShowUnmapped((v) => !v)}
            >
              {showUnmapped ? "Hide list" : "Show list"}
            </button>
          </p>
          {showUnmapped ? (
            <ul className="mt-2 list-disc pl-5 text-amber-800">
              {[...(unmapped ?? []), ...undrawable].map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {enlargedInUse.length > 0 ? (
        <p className="mt-2 text-xs text-gray-500">
          Drawn larger than life so they can be seen and selected:{" "}
          {enlargedInUse.join(", ")}.
        </p>
      ) : null}
    </div>
  );
}
