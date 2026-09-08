"use client";

/**
 * Shared Recharts axis-tick renderers for report charts.
 *
 * `TitleYAxisTick` is the category tick used by the horizontal "top N" bar
 * charts (Catalogue Health, Achievement Over Time). Training full titles are
 * long enough to overrun any sane axis width, so the label is truncated and the
 * full text kept in a `<title>` for the hover tooltip.
 */

/** Truncate to `n` characters, keeping an ellipsis inside the budget. */
export const truncateLabel = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function TitleYAxisTick(props: {
  x?: number;
  y?: number;
  payload?: { value?: string };
  fill?: string;
  /** Characters to keep. Narrower cards need a shorter budget. */
  max?: number;
}) {
  const value = props.payload?.value ?? "";
  const x = typeof props.x === "number" ? props.x : Number(props.x);
  const y = typeof props.y === "number" ? props.y : Number(props.y);
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fontSize={11} fill={props.fill}>
      <title>{value}</title>
      {truncateLabel(value, props.max ?? 48)}
    </text>
  );
}
