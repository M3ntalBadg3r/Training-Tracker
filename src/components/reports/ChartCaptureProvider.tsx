"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { ForceLightChartsContext } from "@/lib/chart-theme";
import { captureCharts, type CapturedChart } from "@/lib/chart-capture";
import type { ReportKpi, ReportKpiTone } from "@/lib/report-export";

/**
 * Lets an export menu anywhere on the page capture the visuals above it — the
 * charts and the `KpiStrip`'s metric boxes.
 *
 * Mounted once in `AppShell`, so any report page's visuals are available to any
 * export button without either side knowing about the other.
 */
export interface PageVisuals {
  charts: CapturedChart[];
  kpis: ReportKpi[];
}

interface ChartCaptureValue {
  /** Charts currently mounted. Zero hides the "include charts" option. */
  chartCount: number;
  /** Called by `ExportableChart` on mount; returns its unregister. */
  registerChart: () => () => void;
  /**
   * Read the KPI strip, then force the light palette, wait for the charts to
   * settle, capture them and restore. Never throws.
   */
  capturePageVisuals: () => Promise<PageVisuals>;
}

const EMPTY_VISUALS: PageVisuals = { charts: [], kpis: [] };

const ChartCaptureContext = createContext<ChartCaptureValue>({
  chartCount: 0,
  registerChart: () => () => {},
  capturePageVisuals: async () => EMPTY_VISUALS,
});

export function useChartCapture(): ChartCaptureValue {
  return useContext(ChartCaptureContext);
}

/**
 * The mounted chart cards, in document order.
 *
 * `querySelectorAll` returns nodes in document order by specification, so the
 * marker attribute gives ordered discovery for free — no registry to keep in
 * sync and no stale nodes to sort. The filter covers the brief window where the
 * App Router has two page trees mounted during a navigation.
 */
function findChartCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-exportable-chart]")).filter(
    (node) => node.isConnected && node.getBoundingClientRect().width > 0
  );
}

const KPI_TONES: ReportKpiTone[] = ["blue", "green", "amber", "red", "indigo", "emerald"];

function isTone(value: string | null): value is ReportKpiTone {
  return value !== null && (KPI_TONES as string[]).includes(value);
}

/**
 * The page's metric boxes, in document order.
 *
 * Same attribute-driven discovery as the charts (see `findChartCards`), reading
 * the markers `KpiStrip` writes. The values are text, so nothing needs
 * rasterising and this can run before the palette flip.
 */
function readKpiCards(): ReportKpi[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-kpi-card]"))
    .filter((node) => node.isConnected && node.getBoundingClientRect().width > 0)
    .map((node) => {
      const tone = node.getAttribute("data-kpi-tone");
      return {
        label: node.getAttribute("data-kpi-label") ?? "",
        value: node.getAttribute("data-kpi-value") ?? "",
        hint: node.getAttribute("data-kpi-hint") ?? undefined,
        tone: isTone(tone) ? tone : undefined,
      };
    })
    .filter((kpi) => kpi.label.length > 0 || kpi.value.length > 0);
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Resolve once the charts stop moving, or give up after `cap` ms.
 *
 * A fixed frame count is the wrong tool: the right answer is ~2 frames when
 * only colours changed, but ~90 if a Recharts animation restarted. Polling for
 * geometric stability is fast in the common case and still correct in the slow
 * one.
 */
async function settle(cards: HTMLElement[], cap = 2000): Promise<void> {
  const signature = () =>
    cards
      .map((card) =>
        Array.from(card.querySelectorAll("path,rect,circle,line"))
          .map((el) => el.getAttribute("d") ?? `${el.getAttribute("width")}x${el.getAttribute("height")}`)
          .join(",")
      )
      .join(";");

  const deadline = performance.now() + cap;
  let previous = "";
  let stableFrames = 0;
  while (performance.now() < deadline) {
    await nextFrame();
    const current = signature();
    stableFrames = current === previous ? stableFrames + 1 : 0;
    previous = current;
    if (stableFrames >= 3) return;
  }
}

export default function ChartCaptureProvider({ children }: { children: ReactNode }) {
  const [chartCount, setChartCount] = useState(0);
  const [forceLight, setForceLight] = useState(false);

  const registerChart = useCallback(() => {
    setChartCount((n) => n + 1);
    return () => setChartCount((n) => n - 1);
  }, []);

  const capturePageVisuals = useCallback(async (): Promise<PageVisuals> => {
    // Read the KPI strip first: it is plain text, so it needs neither the light
    // palette nor the settle wait, and reading it up front means a page whose
    // charts all fail to capture still exports its metrics.
    const kpis = readKpiCards();
    const cards = findChartCards();
    if (cards.length === 0) return { charts: [], kpis };
    try {
      // Commit the palette switch before we start polling for stability, so the
      // first frames we measure are already the light ones.
      flushSync(() => setForceLight(true));
      await settle(cards);
      return { charts: await captureCharts(cards), kpis };
    } catch {
      return { charts: [], kpis };
    } finally {
      setForceLight(false);
    }
  }, []);

  const value = useMemo(
    () => ({ chartCount, registerChart, capturePageVisuals }),
    [chartCount, registerChart, capturePageVisuals]
  );

  return (
    <ChartCaptureContext.Provider value={value}>
      <ForceLightChartsContext.Provider value={forceLight}>
        {children}
      </ForceLightChartsContext.Provider>
    </ChartCaptureContext.Provider>
  );
}

/**
 * Marks a chart card as exportable. Drop-in replacement for the card's own
 * wrapper element — pass the existing `className` through unchanged.
 *
 * Wrap the *card*, not the `ResponsiveContainer`: several reports swap the
 * chart for an empty state, and one renders either a line or a bar chart in a
 * single container. Asking "is there a chart in this card right now?" at
 * capture time handles all of those with no per-page special casing, and it
 * keeps the card's `<h3>` inside the wrapper so the section title can be read
 * from the DOM (some titles are built from the current filters).
 */
export function ExportableChart({
  className,
  title,
  as: Tag = "div",
  children,
}: {
  className?: string;
  /** Overrides the title; by default the card's `<h3>` is read at capture time. */
  title?: string;
  as?: "div" | "section";
  children: ReactNode;
}) {
  const { registerChart } = useChartCapture();
  useEffect(() => registerChart(), [registerChart]);

  return (
    <Tag className={className} data-exportable-chart="" {...(title ? { "data-chart-title": title } : {})}>
      {children}
    </Tag>
  );
}
