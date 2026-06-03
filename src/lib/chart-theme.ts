"use client";

import { useTheme } from "@/components/theme/ThemeProvider";

export const TYPE_COLORS = {
  Certification: "#3b82f6",
  Accreditation: "#10b981",
  "Instructor-Led Training": "#f59e0b",
  OLX: "#0ea5e9",
} as const;

export const TYPE_COLORS_DARK = {
  Certification: "#60a5fa",
  Accreditation: "#34d399",
  "Instructor-Led Training": "#fbbf24",
  OLX: "#38bdf8",
} as const;

export const SERIES_PALETTE = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ef4444",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

export const SERIES_PALETTE_DARK = [
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#a78bfa",
  "#f87171",
  "#22d3ee",
  "#f472b6",
  "#a3e635",
];

// Fallback for product-type-keyed charts when the type has no configured colour.
export const NEUTRAL_GREY = "#9ca3af";
export const NEUTRAL_GREY_DARK = "#6b7280";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface ChartTheme {
  isDark: boolean;
  axis: string;
  grid: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  neutral: string;
  typeColor: (key: keyof typeof TYPE_COLORS) => string;
  series: (i: number) => string;
  /** Look up a configured product-type colour, falling back to neutral grey. */
  productColor: (name: string | null | undefined, map: Record<string, string | null>) => string;
}

export function useChartTheme(): ChartTheme {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const neutral = isDark ? NEUTRAL_GREY_DARK : NEUTRAL_GREY;
  return {
    isDark,
    axis: isDark ? "#9ca3af" : "#6b7280",
    grid: isDark ? "#374151" : "#e5e7eb",
    tooltipBg: isDark ? "#1f2937" : "#ffffff",
    tooltipBorder: isDark ? "#374151" : "#e5e7eb",
    tooltipText: isDark ? "#f3f4f6" : "#111827",
    neutral,
    typeColor: (key) => (isDark ? TYPE_COLORS_DARK[key] : TYPE_COLORS[key]),
    series: (i) => (isDark ? SERIES_PALETTE_DARK : SERIES_PALETTE)[i % SERIES_PALETTE.length],
    productColor: (name, map) => {
      if (!name) return neutral;
      const v = map[name];
      return v && HEX_RE.test(v) ? v : neutral;
    },
  };
}

export function tooltipStyle(t: ChartTheme): React.CSSProperties {
  return {
    backgroundColor: t.tooltipBg,
    border: `1px solid ${t.tooltipBorder}`,
    borderRadius: 6,
    color: t.tooltipText,
  };
}
