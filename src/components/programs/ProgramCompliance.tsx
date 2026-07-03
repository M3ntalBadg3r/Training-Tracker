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
  // Forward-looking projection fields (present only when a horizon is selected).
  // `projectedAttained` is the attained count once certs expiring within the
  // horizon drop out; it is always <= attained.
  projectedAttained?: number;
  projectedGlobalAttained?: number;
  projectedTheatreBreakdown?: { theatre: string; count: number; compliant: boolean }[] | null;
  projectedCompliant?: boolean;
  alternatives: AlternativeEntry[];
}

export interface Specialisation {
  name: string;
  compliant?: boolean;
  projectedCompliant?: boolean;
  requirements: Requirement[];
  // Deployment ("delivery") requirements for this specialisation. They do NOT
  // affect whether the specialisation is achieved (that stays on `requirements`
  // / `compliant`), but a tier that uses the specialisation requires them too,
  // so the level reports surface them with their own met/not-met state.
  deploymentRequirements?: Requirement[];
  deploymentCompliant?: boolean;
  projectedDeploymentCompliant?: boolean;
}

export interface StudentEntry {
  fullName: string;
  email: string;
  country: string;
  theatre: string;
  completedDate: string;
  expiryDate: string;
}

// --- Tiered-program shapes (returned as `tiers` from the compliance API) ---

export interface TierDeploymentRequirement {
  specialisationName: string | null;
  trainingType: string | null;
  trainingTitle: string | null;
  trainingFullTitle: string;
  quantityRequired: number;
  attained: number;
  compliant: boolean;
  minimumPerTheatre: number | null;
  theatreBreakdown: { theatre: string; count: number; compliant: boolean }[] | null;
  projectedAttained: number | null;
  projectedCompliant: boolean | null;
  projectedTheatreBreakdown: { theatre: string; count: number; compliant: boolean }[] | null;
  alternatives: AlternativeEntry[];
}

export interface TierInfo {
  name: string;
  sortOrder: number;
  specialisationsRequired: number;
  compliant: boolean;
  projectedCompliant: boolean | null;
  deploymentRequirements: TierDeploymentRequirement[];
}

export interface TierBlock {
  deploymentMode: string;
  highestAchievedTier: string | null;
  projectedHighestAchievedTier: string | null;
  achievedSpecialisations: string[];
  achievedSpecialisationCount: number;
  projectedAchievedSpecialisationCount: number | null;
  tiers: TierInfo[];
}

export type ViewStudentsFn = (
  trainingTitle: string,
  trainingFullTitle: string,
  level: string,
  filterValue: string,
  alternatives?: AlternativeEntry[]
) => void;

type RiskState = "compliant" | "atRisk" | "nonCompliant";

/**
 * Classify a requirement's compliance taking the projection into account:
 *  - compliant: still meets the requirement at the selected horizon (or now)
 *  - atRisk: meets it now but falls below it by the horizon (amber)
 *  - nonCompliant: already below the requirement today (red)
 * When `projected` is undefined (no horizon) this reduces to the old
 * green/red split on the current attained figure.
 */
function riskState(attained: number, projected: number | undefined, required: number): RiskState {
  const future = projected ?? attained;
  if (future >= required) return "compliant";
  if (attained >= required) return "atRisk";
  return "nonCompliant";
}

const RISK_BG: Record<RiskState, string> = {
  compliant: "bg-green-50",
  atRisk: "bg-amber-50",
  nonCompliant: "bg-red-50",
};

const RISK_TEXT: Record<RiskState, string> = {
  compliant: "text-green-700",
  atRisk: "text-amber-700",
  nonCompliant: "text-red-700",
};

const RISK_BADGE: Record<RiskState, string> = {
  compliant: "bg-green-100 text-green-800",
  atRisk: "bg-amber-100 text-amber-800",
  nonCompliant: "bg-red-100 text-red-800",
};

/** Inline "current → projected" attained value with an optional unit label. */
function AttainedValue({
  attained,
  projected,
  unitLabel,
  className,
}: {
  attained: number;
  projected?: number;
  unitLabel?: string;
  className?: string;
}) {
  const showProjection = projected !== undefined && projected < attained;
  const unit = unitLabel ? ` ${unitLabel}` : "";
  return (
    <span className={className}>
      {showProjection ? (
        <>
          <span className="text-gray-400 font-normal">{attained}</span>
          <span className="mx-1 text-gray-400">→</span>
          <span>{projected}</span>
          {unit}
        </>
      ) : (
        <>
          {attained}
          {unit}
        </>
      )}
    </span>
  );
}

/** Small "▼N expiring" note shown under an at-risk/projected attained value. */
function ExpiringNote({ attained, projected }: { attained: number; projected?: number }) {
  if (projected === undefined || projected >= attained) return null;
  return (
    <div className="text-[11px] text-amber-600 mt-0.5 font-medium">▼{attained - projected} expiring</div>
  );
}

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
  const maxDepReqs = Math.max(...specialisations.map((s) => s.deploymentRequirements?.length ?? 0), 0);
  const colCount = specialisations.length + 1;

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
          {maxDepReqs > 0 && (
            <>
              <tr>
                <td colSpan={colCount} className="px-4 py-2 border border-gray-200 bg-indigo-50">
                  <div className="text-sm font-semibold text-indigo-800">Deployment requirements</div>
                  <div className="text-xs text-indigo-700/80">
                    Required together with the specialisation to qualify for tiers that use it. These do not change
                    whether the specialisation itself is achieved.
                  </div>
                </td>
              </tr>
              {Array.from({ length: maxDepReqs }).map((_, reqIdx) => (
                <RequirementRowGroup
                  key={`dep-${reqIdx}`}
                  reqIdx={reqIdx}
                  specialisations={specialisations}
                  level={level}
                  filterValue={filterValue}
                  onViewStudents={onViewStudents}
                  unitLabel={unitLabel}
                  deployment
                />
              ))}
            </>
          )}
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
  deployment = false,
}: {
  reqIdx: number;
  specialisations: Specialisation[];
  level: string;
  filterValue: string;
  onViewStudents: ViewStudentsFn;
  unitLabel: string;
  deployment?: boolean;
}) {
  const reqsOf = (spec: Specialisation) =>
    deployment ? spec.deploymentRequirements ?? [] : spec.requirements;
  return (
    <>
      {/* Training name row */}
      <tr className="bg-gray-50/50">
        <td className="px-4 py-2 font-medium text-gray-600 border border-gray-200">
          Training
        </td>
        {specialisations.map((spec) => {
          const req = reqsOf(spec)[reqIdx];
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
          const req = reqsOf(spec)[reqIdx];
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
          const req = reqsOf(spec)[reqIdx];
          if (!req) {
            return (
              <td key={spec.name} className="px-4 py-2 text-center border border-gray-200">
                <span className="text-gray-300">—</span>
              </td>
            );
          }
          const state = riskState(req.attained, req.projectedAttained, req.quantityRequired);
          return (
            <td
              key={spec.name}
              className={`px-4 py-2 text-center border border-gray-200 ${RISK_BG[state]}`}
            >
              <AttainedValue
                attained={req.attained}
                projected={req.projectedAttained}
                unitLabel={unitLabel}
                className={`font-bold ${RISK_TEXT[state]}`}
              />
              {level !== "global" && req.trainingTitle && (
                <button
                  onClick={() => onViewStudents(req.trainingTitle!, req.trainingFullTitle, level, filterValue, req.alternatives)}
                  className="ml-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                >
                  <Users size={12} /> View
                </button>
              )}
              <ExpiringNote attained={req.attained} projected={req.projectedAttained} />
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
  const deploymentReqs = spec.deploymentRequirements ?? [];
  const hasDeployment = deploymentReqs.length > 0;
  return (
    <div className="mb-6 bg-white rounded-lg border border-gray-200 overflow-hidden">
      {(() => {
        const state: RiskState = spec.compliant
          ? spec.projectedCompliant === false
            ? "atRisk"
            : "compliant"
          : "nonCompliant";
        const label =
          state === "compliant" ? "Compliant" : state === "atRisk" ? "At Risk" : "Not Compliant";
        const depState: RiskState = spec.deploymentCompliant
          ? spec.projectedDeploymentCompliant === false
            ? "atRisk"
            : "compliant"
          : "nonCompliant";
        const depLabel =
          depState === "compliant"
            ? "Deployment: Met"
            : depState === "atRisk"
              ? "Deployment: At Risk"
              : "Deployment: Not Met";
        return (
          <div className="flex items-center justify-between gap-2 px-5 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold">{spec.name}</h2>
            <div className="flex items-center gap-2">
              {hasDeployment && (
                <span className={`px-3 py-1 rounded-full text-xs font-medium ${RISK_BADGE[depState]}`}>
                  {depLabel}
                </span>
              )}
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${RISK_BADGE[state]}`}>
                {label}
              </span>
            </div>
          </div>
        );
      })()}
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
            {hasDeployment && (
              <>
                <tr className="bg-indigo-50">
                  <td colSpan={7} className="px-4 py-2">
                    <div className="text-sm font-semibold text-indigo-800">Deployment requirements</div>
                    <div className="text-xs text-indigo-700/80">
                      Required together with the specialisation to qualify for tiers that use it. These do not
                      change whether the specialisation itself is achieved.
                    </div>
                  </td>
                </tr>
                {deploymentReqs.map((req, i) => (
                  <RequirementRows key={`dep-${i}`} req={req} />
                ))}
              </>
            )}
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
  const projectedGlobalAttained = req.projectedGlobalAttained;
  const attainedState = riskState(globalAttained, projectedGlobalAttained, req.quantityRequired);
  // Status reflects the full compliance (incl. per-theatre minimums) at the horizon.
  const statusState: RiskState = req.compliant
    ? req.projectedCompliant === false
      ? "atRisk"
      : "compliant"
    : "nonCompliant";
  const statusLabel =
    statusState === "compliant" ? "Met" : statusState === "atRisk" ? "At Risk" : "Not Met";

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
        <td className="px-4 py-3 text-center">
          <AttainedValue
            attained={globalAttained}
            projected={projectedGlobalAttained}
            className={`font-bold ${RISK_TEXT[attainedState]}`}
          />
          <ExpiringNote attained={globalAttained} projected={projectedGlobalAttained} />
        </td>
        <td className="px-4 py-3 text-center text-gray-600">{req.minimumPerTheatre ?? "—"}</td>
        <td className="px-4 py-3 text-center">
          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${RISK_BADGE[statusState]}`}>
            {statusLabel}
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
                  {req.theatreBreakdown.map((t) => {
                    const projectedCount = req.projectedTheatreBreakdown?.find(
                      (p) => p.theatre === t.theatre
                    )?.count;
                    const required = req.minimumPerTheatre ?? 0;
                    const tState = riskState(t.count, projectedCount, required);
                    const tLabel =
                      tState === "compliant" ? "Met" : tState === "atRisk" ? "At Risk" : "Not Met";
                    return (
                      <tr key={t.theatre} className="border-t border-gray-200">
                        <td className="px-3 py-2">{t.theatre}</td>
                        <td className="px-3 py-2 text-center">
                          <AttainedValue
                            attained={t.count}
                            projected={projectedCount}
                            className={`font-semibold ${RISK_TEXT[tState]}`}
                          />
                          <ExpiringNote attained={t.count} projected={projectedCount} />
                        </td>
                        <td className="px-3 py-2 text-center">{req.minimumPerTheatre}</td>
                        <td className="px-3 py-2 text-center">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${RISK_BADGE[tState]}`}
                          >
                            {tLabel}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
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

/** One deployment requirement row inside a tier card (with per-theatre expand). */
function TierRequirementRow({ req }: { req: TierDeploymentRequirement }) {
  const [expanded, setExpanded] = useState(false);
  const projected = req.projectedAttained ?? undefined;
  const state = riskState(req.attained, projected, req.quantityRequired);
  const hasBreakdown = req.theatreBreakdown && req.theatreBreakdown.length > 0;
  return (
    <div className={`rounded border ${RISK_BG[state]} border-gray-200 px-3 py-2`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          {req.specialisationName && (
            <span className="text-[11px] uppercase tracking-wide text-gray-500 mr-1">{req.specialisationName}:</span>
          )}
          <span className="text-sm">
            {req.trainingFullTitle}
            {req.alternatives.length > 0 && (
              <span className="text-xs text-gray-500"> or {req.alternatives.map((a) => a.trainingFullTitle).join(", ")}</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-sm font-semibold ${RISK_TEXT[state]}`}>
            <AttainedValue attained={req.attained} projected={projected} /> / {req.quantityRequired}
          </span>
          {hasBreakdown && (
            <button onClick={() => setExpanded((p) => !p)} className="text-gray-400 hover:text-gray-600">
              {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          )}
        </div>
      </div>
      <ExpiringNote attained={req.attained} projected={projected} />
      {expanded && hasBreakdown && (
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-1">
          {req.theatreBreakdown!.map((t) => {
            const tProj = req.projectedTheatreBreakdown?.find((p) => p.theatre === t.theatre)?.count;
            const tState = riskState(t.count, tProj, req.minimumPerTheatre ?? 0);
            return (
              <div key={t.theatre} className={`text-xs rounded px-2 py-1 ${RISK_BADGE[tState]}`}>
                {t.theatre}: <AttainedValue attained={t.count} projected={tProj} />
                {req.minimumPerTheatre ? ` / ${req.minimumPerTheatre}` : ""}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The tier ladder for a tiered program at a given level + scope: a highest-tier
 * banner, the achieved specialisations, and one card per tier showing the
 * specialisation gate + deployment requirements and whether it is reached.
 */
export function TierLadder({ block }: { block: TierBlock }) {
  const achieved = block.achievedSpecialisationCount;
  const projAchieved = block.projectedAchievedSpecialisationCount;
  const sorted = [...block.tiers].sort((a, b) => a.sortOrder - b.sortOrder);
  // Next tier to aim for = the lowest tier not currently compliant.
  const nextTier = sorted.find((t) => !t.compliant) ?? null;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm text-gray-500">Highest tier achieved:</span>
          <span className={`px-2.5 py-1 rounded-full text-sm font-semibold ${block.highestAchievedTier ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}`}>
            {block.highestAchievedTier ?? "None"}
          </span>
          {block.projectedHighestAchievedTier !== null &&
            block.projectedHighestAchievedTier !== block.highestAchievedTier && (
              <span className="text-sm text-amber-700">
                → projected <strong>{block.projectedHighestAchievedTier ?? "None"}</strong>
              </span>
            )}
        </div>
        <div className="mt-2 text-sm text-gray-600">
          <span className="font-medium">
            {achieved}
            {projAchieved !== null && projAchieved !== achieved && <span className="text-amber-700"> → {projAchieved}</span>}
          </span>{" "}
          specialisation{achieved === 1 ? "" : "s"} achieved
          {block.achievedSpecialisations.length > 0 && (
            <span className="ml-1 text-gray-500">
              ({block.achievedSpecialisations.join(", ")})
            </span>
          )}
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500">No tiers configured for this program yet.</p>
      ) : (
        sorted.map((tier) => {
          const specsMet = achieved >= tier.specialisationsRequired;
          const isNext = nextTier?.name === tier.name;
          return (
            <div
              key={tier.name}
              className={`rounded-lg border p-4 ${tier.compliant ? "border-green-300 bg-green-50/40" : isNext ? "border-blue-300 bg-blue-50/30" : "border-gray-200 bg-white"}`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-gray-800">{tier.name}</h3>
                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${tier.compliant ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}`}>
                  {tier.compliant ? "Achieved" : isNext ? "Next tier" : "Not yet"}
                </span>
              </div>

              <div className="mt-2 text-sm">
                <span className={specsMet ? "text-green-700" : "text-red-700"}>
                  Specialisations: {achieved} / {tier.specialisationsRequired}
                </span>
                {!specsMet && (
                  <span className="ml-2 text-gray-500">
                    (need {tier.specialisationsRequired - achieved} more)
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-gray-500">
                Achieved:{" "}
                {block.achievedSpecialisations.length > 0 ? (
                  <span className="text-gray-700">{block.achievedSpecialisations.join(", ")}</span>
                ) : (
                  <span className="italic">none yet</span>
                )}
              </div>

              {tier.deploymentRequirements.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <div className="text-xs font-medium text-gray-600 uppercase tracking-wide">Deployment requirements</div>
                  {tier.deploymentRequirements.map((req, i) => (
                    <TierRequirementRow key={`${req.trainingTitle ?? i}-${req.specialisationName ?? ""}`} req={req} />
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
