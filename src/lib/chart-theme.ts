"use client";

import { useTheme } from "@/components/theme/ThemeProvider";

export const TYPE_COLORS = {
  Certification: "#3b82f6",
  Accreditation: "#10b981",
  "Instructor-Led Training": "#f59e0b",
} as const;

export const TYPE_COLORS_DARK = {
  Certification: "#60a5fa",
  Accreditation: "#34d399",
  "Instructor-Led Training": "#fbbf24",
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

export interface ChartTheme {
  isDark: boolean;
  axis: string;
  grid: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  typeColor: (key: keyof typeof TYPE_COLORS) => string;
  series: (i: number) => string;
}

export function useChartTheme(): ChartTheme {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  return {
    isDark,
    axis: isDark ? "#9ca3af" : "#6b7280",
    grid: isDark ? "#374151" : "#e5e7eb",
    tooltipBg: isDark ? "#1f2937" : "#ffffff",
    tooltipBorder: isDark ? "#374151" : "#e5e7eb",
    tooltipText: isDark ? "#f3f4f6" : "#111827",
    typeColor: (key) => (isDark ? TYPE_COLORS_DARK[key] : TYPE_COLORS[key]),
    series: (i) => (isDark ? SERIES_PALETTE_DARK : SERIES_PALETTE)[i % SERIES_PALETTE.length],
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
