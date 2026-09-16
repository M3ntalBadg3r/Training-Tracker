"use client";

import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { useChartCapture } from "@/components/reports/ChartCaptureProvider";
import { useIncludeCharts } from "@/hooks/useIncludeCharts";

export type ExportFormat = "csv" | "excel" | "pdf";

/**
 * One labelled section of a multi-part export menu.
 *
 * The training catalogue offers the same three formats twice — the catalogue
 * alone, and the catalogue joined with its students, which has to be fetched
 * and so carries its own busy flag. That page had its own dropdown purely
 * because this component could not express the grouping.
 */
export interface ExportGroup {
  label: string;
  onExport: (fmt: ExportFormat) => void | Promise<void>;
  busy?: boolean;
}

/**
 * The export dropdown shared by every report page.
 *
 * Replaces the near-identical private copy each report used to carry. Beyond
 * the three formats it offers "Include charts & metrics in PDF", which appears
 * only when the page actually has charts registered with `ChartCaptureProvider`
 * — CSV cannot hold an image and the Excel writer (SheetJS community) cannot
 * embed one, so the option is named for the format it applies to. The metrics
 * are the page's KPI strip, redrawn in the PDF rather than pictured.
 *
 * Not to be confused with the `ExportMenu` in `components/programs/
 * ProgramCompliance.tsx`, which is a different, controlled component serving
 * the program and offering dashboards (none of which have charts).
 */
export default function ExportMenu({
  onExport,
  groups,
  busy = false,
  label = "Export",
  align = "right",
  show: controlledShow,
  setShow: setControlledShow,
}: {
  onExport?: (fmt: ExportFormat, opts: { includeCharts: boolean }) => void | Promise<void>;
  /** Labelled sections, each offering the three formats. Replaces `onExport`. */
  groups?: ExportGroup[];
  busy?: boolean;
  label?: string;
  align?: "left" | "right";
  /**
   * Optional controlled open state. The program/offering dashboards own the
   * flag themselves (one page renders several of these menus), so they pass it
   * in; every other caller leaves it alone and the internal state is used.
   */
  show?: boolean;
  setShow?: (v: boolean) => void;
}) {
  const [internalShow, setInternalShow] = useState(false);
  const show = controlledShow ?? internalShow;
  const setShow = setControlledShow ?? setInternalShow;
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
  }, [show, setShow]);

  const offerCharts = chartCount > 0;

  const run = (fmt: ExportFormat) => {
    setShow(false);
    void onExport?.(fmt, { includeCharts: offerCharts && includeCharts });
  };

  const runGroup = (group: ExportGroup, fmt: ExportFormat) => {
    setShow(false);
    void group.onExport(fmt);
  };

  const FORMATS: { fmt: ExportFormat; label: string }[] = [
    { fmt: "csv", label: "Export as CSV" },
    { fmt: "excel", label: "Export as Excel" },
    { fmt: "pdf", label: "Export as PDF" },
  ];

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setShow(!show)}
        disabled={busy}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300 disabled:opacity-50"
      >
        <Download size={16} /> {busy ? "Exporting…" : label}
      </button>
      {show && !busy && (
        <div
          className={`absolute ${align === "right" ? "right-0" : "left-0"} mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 ${groups ? "min-w-[220px]" : offerCharts ? "min-w-[250px]" : "min-w-[140px]"}`}
        >
          {groups ? (
            groups.map((group, gi) => (
              <div key={group.label} className={gi > 0 ? "border-t border-gray-100" : undefined}>
                <div className="text-xs uppercase tracking-wide text-gray-500 px-4 pt-2 pb-1">
                  {group.label}
                </div>
                {FORMATS.map((f) => (
                  <button
                    key={f.fmt}
                    disabled={group.busy}
                    onClick={() => runGroup(group, f.fmt)}
                    className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 disabled:opacity-50 disabled:cursor-wait"
                  >
                    {group.busy ? "Preparing…" : f.label}
                  </button>
                ))}
              </div>
            ))
          ) : (
            <>
              {offerCharts && (
                <label className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 border-b border-gray-200 cursor-pointer select-none rounded-t-lg hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={includeCharts}
                    onChange={(e) => setIncludeCharts(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  Include charts &amp; metrics in PDF
                </label>
              )}
              {FORMATS.map((f, i) => (
                <button
                  key={f.fmt}
                  onClick={() => run(f.fmt)}
                  className={`block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 ${
                    i === 0 && !offerCharts ? "rounded-t-lg" : ""
                  } ${i === FORMATS.length - 1 ? "rounded-b-lg" : ""}`}
                >
                  {f.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
