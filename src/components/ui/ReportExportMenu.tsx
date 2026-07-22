"use client";

import { Download } from "lucide-react";
import {
  exportReportToCsv,
  exportReportToExcel,
  exportReportToPdf,
  type ReportDocument,
} from "@/lib/report-export";

/**
 * Whole-page ("report") export dropdown — the multi-section sibling of the
 * single-table `ExportMenu` in `components/programs/ProgramCompliance.tsx`.
 *
 * Takes a `ReportDocument` (or a builder returning one, so the page can defer
 * assembling it until a format is chosen) and offers CSV / Excel / PDF. Any page
 * that wants a "download the whole thing" button can reuse this.
 */
export function ReportExportMenu({
  show,
  setShow,
  document,
  filename,
  label = "Export report",
  align = "left",
}: {
  show: boolean;
  setShow: (v: boolean) => void;
  document: ReportDocument | (() => ReportDocument);
  filename: string;
  label?: string;
  align?: "left" | "right";
}) {
  const resolve = () => (typeof document === "function" ? document() : document);
  return (
    <div className="relative">
      <button
        onClick={() => setShow(!show)}
        className="flex items-center gap-1 px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
      >
        <Download size={16} /> {label}
      </button>
      {show && (
        <div
          className={`absolute ${align === "right" ? "right-0" : "left-0"} mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[160px]`}
        >
          <button
            className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
            onClick={() => {
              exportReportToCsv(resolve(), filename);
              setShow(false);
            }}
          >
            Export as CSV
          </button>
          <button
            className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
            onClick={() => {
              exportReportToExcel(resolve(), filename);
              setShow(false);
            }}
          >
            Export as Excel
          </button>
          <button
            className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
            onClick={() => {
              exportReportToPdf(resolve(), filename);
              setShow(false);
            }}
          >
            Export as PDF
          </button>
        </div>
      )}
    </div>
  );
}
