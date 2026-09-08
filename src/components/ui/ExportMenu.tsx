"use client";

import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { useChartCapture } from "@/components/reports/ChartCaptureProvider";
import { useIncludeCharts } from "@/hooks/useIncludeCharts";

export type ExportFormat = "csv" | "excel" | "pdf";

/**
 * The export dropdown shared by every report page.
 *
 * Replaces the near-identical private copy each report used to carry. Beyond
 * the three formats it offers "Include charts in PDF", which appears only when
 * the page actually has charts registered with `ChartCaptureProvider` — CSV
 * cannot hold an image and the Excel writer (SheetJS community) cannot embed
 * one, so the option is named for the format it applies to.
 *
 * Not to be confused with the `ExportMenu` in `components/programs/
 * ProgramCompliance.tsx`, which is a different, controlled component serving
 * the program and offering dashboards (none of which have charts).
 */
export default function ExportMenu({
  onExport,
  busy = false,
  label = "Export",
  align = "right",
}: {
  onExport: (fmt: ExportFormat, opts: { includeCharts: boolean }) => void | Promise<void>;
  busy?: boolean;
  label?: string;
  align?: "left" | "right";
}) {
  const [show, setShow] = useState(false);
  const [includeCharts, setIncludeCharts] = useIncludeCharts();
  const { chartCount } = useChartCapture();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on an outside click. The old per-page menus had no such handler, but
  // they also had nothing in them worth leaving open — a panel holding a sticky
  // checkbox that will not go away is a good deal more irritating.
  useEffect(() => {
    if (!show) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setShow(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [show]);

  const offerCharts = chartCount > 0;

  const run = (fmt: ExportFormat) => {
    setShow(false);
    void onExport(fmt, { includeCharts: offerCharts && includeCharts });
  };

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setShow((p) => !p)}
        disabled={busy}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300 disabled:opacity-50"
      >
        <Download size={16} /> {busy ? "Exporting…" : label}
      </button>
      {show && !busy && (
        <div
          className={`absolute ${align === "right" ? "right-0" : "left-0"} mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 ${offerCharts ? "min-w-[220px]" : "min-w-[140px]"}`}
        >
          {offerCharts && (
            <label className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 border-b border-gray-200 cursor-pointer select-none rounded-t-lg hover:bg-gray-50">
              <input
                type="checkbox"
                checked={includeCharts}
                onChange={(e) => setIncludeCharts(e.target.checked)}
                className="rounded border-gray-300"
              />
              Include charts in PDF
            </label>
          )}
          <button
            onClick={() => run("csv")}
            className={`block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 ${offerCharts ? "" : "rounded-t-lg"}`}
          >
            Export as CSV
          </button>
          <button
            onClick={() => run("excel")}
            className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
          >
            Export as Excel
          </button>
          <button
            onClick={() => run("pdf")}
            className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg"
          >
            Export as PDF
          </button>
        </div>
      )}
    </div>
  );
}
