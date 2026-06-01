"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Users,
} from "lucide-react";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";

export const TRAINING_TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
  InstructorLedTraining: "Instructor-Led Training",
  OLX: "OLX",
};

export interface AlternativeEntry {
  trainingType: string;
  trainingTitle: string;
  trainingFullTitle: string;
}

export interface Requirement {
  trainingType: string | null;
  trainingTitle: string | null;
  trainingFullTitle: string;
  quantityRequired: number;
  attained: number;
  // Global Diamond-style fields (present at the Global level).
  globalAttained?: number;
  minimumPerTheatre?: number | null;
  theatreBreakdown?: { theatre: string; count: number; compliant: boolean }[] | null;
  compliant?: boolean;
  alternatives: AlternativeEntry[];
}

export interface Specialisation {
  name: string;
  compliant?: boolean;
  requirements: Requirement[];
}

export interface StudentEntry {
  fullName: string;
  email: string;
  country: string;
  theatre: string;
  completedDate: string;
  expiryDate: string;
}

export type ViewStudentsFn = (
  trainingTitle: string,
  trainingFullTitle: string,
  level: string,
  filterValue: string,
  alternatives?: AlternativeEntry[]
) => void;

/**
 * APS-style side-by-side specialisation matrix (one column per specialisation,
 * grouped rows of Training / Required / Attained).
 */
export function ComplianceTable({
  specialisations,
  level,
  filterValue,
  onViewStudents,
  unitLabel,
}: {
  specialisations: Specialisation[];
  level: string;
  filterValue: string;
  onViewStudents: ViewStudentsFn;
  unitLabel: string;
}) {
  const maxReqs = Math.max(...specialisations.map((s) => s.requirements.length), 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-gray-50">
            <th className="px-4 py-3 text-left font-semibold text-gray-700 border border-gray-200 min-w-[120px]">
              &nbsp;
            </th>
            {specialisations.map((spec) => (
              <th
                key={spec.name}
                className="px-4 py-3 text-center font-semibold text-gray-700 border border-gray-200 min-w-[200px]"
              >
                {spec.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: maxReqs }).map((_, reqIdx) => (
            <RequirementRowGroup
              key={reqIdx}
              reqIdx={reqIdx}
              specialisations={specialisations}
              level={level}
              filterValue={filterValue}
              onViewStudents={onViewStudents}
              unitLabel={unitLabel}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequirementRowGroup({
  reqIdx,
  specialisations,
  level,
  filterValue,
  onViewStudents,
  unitLabel,
}: {
  reqIdx: number;
  specialisations: Specialisation[];
  level: string;
  filterValue: string;
  onViewStudents: ViewStudentsFn;
  unitLabel: string;
}) {
  return (
    <>
      {/* Training name row */}
      <tr className="bg-gray-50/50">
        <td className="px-4 py-2 font-medium text-gray-600 border border-gray-200">
          Training
        </td>
        {specialisations.map((spec) => {
          const req = spec.requirements[reqIdx];
          return (
            <td key={spec.name} className="px-4 py-2 text-center border border-gray-200">
              {req ? (
                <div>
                  <div className="font-medium">{req.trainingFullTitle}</div>
                  <div className="text-xs text-gray-500">
                    {req.trainingType ? TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType : "—"}
                  </div>
                  {req.alternatives && req.alternatives.length > 0 && (
                    <div className="text-xs text-blue-600 mt-1">
                      {req.alternatives.map((a, i) => (
                        <span key={i}>
                          {i === 0 ? "or " : ", "}<span className="font-medium">{a.trainingFullTitle}</span>
                          <span className="text-gray-400"> ({TRAINING_TYPE_LABELS[a.trainingType] || a.trainingType})</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <span className="text-gray-300">—</span>
              )}
            </td>
          );
        })}
      </tr>
      {/* Required row */}
      <tr>
        <td className="px-4 py-2 font-medium text-gray-600 border border-gray-200">
          Required
        </td>
        {specialisations.map((spec) => {
          const req = spec.requirements[reqIdx];
          return (
            <td key={spec.name} className="px-4 py-2 text-center border border-gray-200">
              {req ? (
                <span className="font-semibold">
                  {req.quantityRequired} {unitLabel}
                </span>
              ) : (
                <span className="text-gray-300">—</span>
              )}
            </td>
          );
        })}
      </tr>
      {/* Attained row */}
      <tr>
        <td className="px-4 py-2 font-medium text-gray-600 border border-gray-200">
          Attained
        </td>
        {specialisations.map((spec) => {
          const req = spec.requirements[reqIdx];
          if (!req) {
            return (
              <td key={spec.name} className="px-4 py-2 text-center border border-gray-200">
                <span className="text-gray-300">—</span>
              </td>
            );
          }
          const compliant = req.attained >= req.quantityRequired;
          return (
            <td
              key={spec.name}
              className={`px-4 py-2 text-center border border-gray-200 ${compliant ? "bg-green-50" : "bg-red-50"}`}
            >
              <span className={`font-bold ${compliant ? "text-green-700" : "text-red-700"}`}>
                {req.attained} {unitLabel}
              </span>
              {level !== "global" && req.trainingTitle && (
                <button
                  onClick={() => onViewStudents(req.trainingTitle!, req.trainingFullTitle, level, filterValue, req.alternatives)}
                  className="ml-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                >
                  <Users size={12} /> View
                </button>
              )}
            </td>
          );
        })}
      </tr>
      {/* Spacer row between requirement groups */}
      <tr>
        <td colSpan={specialisations.length + 1} className="h-1 bg-gray-100 border-0" />
      </tr>
    </>
  );
}

/**
 * Global Diamond-style card: one card per specialisation with a status badge
 * and a table of requirements, each expandable to a per-theatre breakdown.
 */
export function SpecialisationCard({ spec }: { spec: Specialisation }) {
  return (
    <div className="mb-6 bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <h2 className="text-lg font-semibold">{spec.name}</h2>
        <span
          className={`px-3 py-1 rounded-full text-sm font-medium ${
            spec.compliant ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
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

function RequirementRows({ req }: { req: Requirement }) {
  const [expanded, setExpanded] = useState(false);
  const hasTheatreBreakdown = req.theatreBreakdown != null && req.theatreBreakdown.length > 0;
  const globalAttained = req.globalAttained ?? req.attained;

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
            globalAttained >= req.quantityRequired ? "text-green-700" : "text-red-700"
          }`}
        >
          {globalAttained}
        </td>
        <td className="px-4 py-3 text-center text-gray-600">{req.minimumPerTheatre ?? "—"}</td>
        <td className="px-4 py-3 text-center">
          <span
            className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
              req.compliant ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
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

export function ExportMenu({
  show,
  setShow,
  data,
  columns,
  filename,
  align = "left",
}: {
  show: boolean;
  setShow: (v: boolean) => void;
  data: Record<string, string | number>[];
  columns: { key: string; header: string }[];
  filename: string;
  align?: "left" | "right";
}) {
  return (
    <div className="relative">
      <button
        onClick={() => setShow(!show)}
        className="flex items-center gap-1 px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
      >
        <Download size={16} /> Export
      </button>
      {show && (
        <div className={`absolute ${align === "right" ? "right-0" : "left-0"} mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]`}>
          <button
            className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
            onClick={() => { exportToCsv(data as never[], columns as never[], filename); setShow(false); }}
          >
            Export as CSV
          </button>
          <button
            className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
            onClick={() => { exportToExcel(data as never[], columns as never[], filename); setShow(false); }}
          >
            Export as Excel
          </button>
          <button
            className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
            onClick={() => { exportToPdf(data as never[], columns as never[], filename); setShow(false); }}
          >
            Export as PDF
          </button>
        </div>
      )}
    </div>
  );
}

export function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
    </div>
  );
}
