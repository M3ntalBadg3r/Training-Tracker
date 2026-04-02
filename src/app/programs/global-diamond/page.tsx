"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import type { GlobalDiamondReportData, GlobalDiamondRequirement } from "@/types";

const TRAINING_TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
  InstructorLedTraining: "Instructor-Led Training",
};

export default function GlobalDiamondPage() {
  const [data, setData] = useState<GlobalDiamondReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showExport, setShowExport] = useState(false);

  useEffect(() => {
    fetch("/api/programs/global-diamond")
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setError("Failed to load compliance data"))
      .finally(() => setLoading(false));
  }, []);

  const buildExportData = () => {
    if (!data) return [];
    const rows: Record<string, string | number>[] = [];
    for (const spec of data.specialisations) {
      for (const req of spec.requirements) {
        let trainingLabel = req.trainingFullTitle;
        if (req.alternatives && req.alternatives.length > 0) {
          trainingLabel += " (or " + req.alternatives.map((a: { trainingFullTitle: string }) => a.trainingFullTitle).join(", ") + ")";
        }
        const baseRow = {
          specialisation: spec.name,
          training: trainingLabel,
          type: req.trainingType ? (TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType) : "—",
          required: req.quantityRequired,
          attained: req.globalAttained,
          compliant: req.compliant ? "Yes" : "No",
          theatre: "Global",
          theatreCount: req.globalAttained,
          theatreRequired: req.quantityRequired,
          theatreCompliant: req.compliant ? "Yes" : "No",
        };
        rows.push(baseRow);
        if (req.theatreBreakdown) {
          for (const t of req.theatreBreakdown) {
            rows.push({
              specialisation: spec.name,
              training: req.trainingFullTitle,
              type: req.trainingType ? (TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType) : "—",
              required: req.quantityRequired,
              attained: req.globalAttained,
              compliant: req.compliant ? "Yes" : "No",
              theatre: t.theatre,
              theatreCount: t.count,
              theatreRequired: req.minimumPerTheatre ?? 0,
              theatreCompliant: t.compliant ? "Yes" : "No",
            });
          }
        }
      }
    }
    return rows;
  };

  const exportCols = [
    { key: "specialisation", header: "Specialisation" },
    { key: "training", header: "Training" },
    { key: "type", header: "Type" },
    { key: "required", header: "Global Required" },
    { key: "attained", header: "Global Attained" },
    { key: "compliant", header: "Compliant" },
    { key: "theatre", header: "Theatre" },
    { key: "theatreCount", header: "Theatre Count" },
    { key: "theatreRequired", header: "Theatre Required" },
    { key: "theatreCompliant", header: "Theatre Compliant" },
  ];

  return (
    <div>
      <PageHeader
        title="Global Diamond"
        helpSlug="programs-global-diamond"
        rightContent={
          data && data.specialisations.length > 0 ? (
            <div className="relative">
              <button
                onClick={() => setShowExport((p) => !p)}
                className="flex items-center gap-1 px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                <Download size={16} /> Export
              </button>
              {showExport && (
                <div className="absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
                  <button
                    className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
                    onClick={() => { exportToCsv(buildExportData() as never[], exportCols as never[], "global-diamond"); setShowExport(false); }}
                  >
                    Export as CSV
                  </button>
                  <button
                    className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
                    onClick={() => { exportToExcel(buildExportData() as never[], exportCols as never[], "global-diamond"); setShowExport(false); }}
                  >
                    Export as Excel
                  </button>
                  <button
                    className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
                    onClick={() => { exportToPdf(buildExportData() as never[], exportCols as never[], "global-diamond"); setShowExport(false); }}
                  >
                    Export as PDF
                  </button>
                </div>
              )}
            </div>
          ) : null
        }
      />

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg">{error}</div>
      )}

      {!loading && !error && data && data.specialisations.length === 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          No Global Diamond program data configured yet. Add requirements in{" "}
          <a href="/admin/program-data" className="text-blue-600 hover:underline">
            Admin &rsaquo; Program Data
          </a>{" "}
          using the program name <strong>Global Diamond</strong>.
        </div>
      )}

      {!loading && !error && data && data.specialisations.map((spec) => (
        <SpecialisationCard key={spec.name} spec={spec} />
      ))}
    </div>
  );
}

function SpecialisationCard({ spec }: { spec: GlobalDiamondReportData["specialisations"][0] }) {
  return (
    <div className="mb-6 bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <h2 className="text-lg font-semibold">{spec.name}</h2>
        <span
          className={`px-3 py-1 rounded-full text-sm font-medium ${
            spec.compliant
              ? "bg-green-100 text-green-800"
              : "bg-red-100 text-red-800"
          }`}
        >
          {spec.compliant ? "Compliant" : "Not Compliant"}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-4 py-3 font-medium text-gray-600 w-6" />
              <th className="px-4 py-3 font-medium text-gray-600">Training</th>
              <th className="px-4 py-3 font-medium text-gray-600">Type</th>
              <th className="px-4 py-3 font-medium text-gray-600 text-center">Required (Global)</th>
              <th className="px-4 py-3 font-medium text-gray-600 text-center">Attained</th>
              <th className="px-4 py-3 font-medium text-gray-600 text-center">Min/Theatre</th>
              <th className="px-4 py-3 font-medium text-gray-600 text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {spec.requirements.map((req, i) => (
              <RequirementRows key={i} req={req} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RequirementRows({ req }: { req: GlobalDiamondRequirement }) {
  const [expanded, setExpanded] = useState(false);
  const hasTheatreBreakdown = req.theatreBreakdown !== null && req.theatreBreakdown.length > 0;

  return (
    <>
      <tr className="border-t border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-3">
          {hasTheatreBreakdown ? (
            <button
              onClick={() => setExpanded((p) => !p)}
              className="text-gray-400 hover:text-gray-700"
              title={expanded ? "Collapse theatre breakdown" : "Expand theatre breakdown"}
            >
              {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          ) : null}
        </td>
        <td className="px-4 py-3">
          <div className="font-medium">{req.trainingFullTitle}</div>
          {req.alternatives && req.alternatives.length > 0 && (
            <div className="text-xs text-blue-600 mt-0.5">
              {req.alternatives.map((a, i) => (
                <span key={i}>
                  {i === 0 ? "or " : ", "}<span className="font-medium">{a.trainingFullTitle}</span>
                  <span className="text-gray-400"> ({TRAINING_TYPE_LABELS[a.trainingType] || a.trainingType})</span>
                </span>
              ))}
            </div>
          )}
        </td>
        <td className="px-4 py-3 text-gray-600">
          {req.trainingType ? (TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType) : "—"}
        </td>
        <td className="px-4 py-3 text-center font-semibold">{req.quantityRequired}</td>
        <td
          className={`px-4 py-3 text-center font-bold ${
            req.globalAttained >= req.quantityRequired ? "text-green-700" : "text-red-700"
          }`}
        >
          {req.globalAttained}
        </td>
        <td className="px-4 py-3 text-center text-gray-600">
          {req.minimumPerTheatre ?? "—"}
        </td>
        <td className="px-4 py-3 text-center">
          <span
            className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
              req.compliant
                ? "bg-green-100 text-green-800"
                : "bg-red-100 text-red-800"
            }`}
          >
            {req.compliant ? "Met" : "Not Met"}
          </span>
        </td>
      </tr>
      {expanded && req.theatreBreakdown && (
        <tr className="bg-gray-50">
          <td colSpan={7} className="px-4 pb-3 pt-0">
            <div className="ml-6 rounded border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-gray-600">Theatre</th>
                    <th className="px-3 py-2 text-center font-medium text-gray-600">Count</th>
                    <th className="px-3 py-2 text-center font-medium text-gray-600">Required</th>
                    <th className="px-3 py-2 text-center font-medium text-gray-600">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {req.theatreBreakdown.map((t) => (
                    <tr key={t.theatre} className="border-t border-gray-200">
                      <td className="px-3 py-2">{t.theatre}</td>
                      <td className={`px-3 py-2 text-center font-semibold ${t.compliant ? "text-green-700" : "text-red-700"}`}>
                        {t.count}
                      </td>
                      <td className="px-3 py-2 text-center">{req.minimumPerTheatre}</td>
                      <td className="px-3 py-2 text-center">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                            t.compliant ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
                          }`}
                        >
                          {t.compliant ? "Met" : "Not Met"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
