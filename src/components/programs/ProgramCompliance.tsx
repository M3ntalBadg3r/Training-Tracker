"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Users,
} from "lucide-react";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { exportReportToPdf, type ReportDocument, type ReportTone } from "@/lib/report-export";
import SharedExportMenu, { type ExportFormat } from "@/components/ui/ExportMenu";
import LoadingState from "@/components/ui/LoadingState";
import {
  AGGREGATION_SHORT_LABELS,
  isMultiCountryLevel,
  parseScopeLevel,
  SCOPE_TO_REQ_LEVEL,
  type Aggregation,
  type CountryBreakdownRow,
} from "@/lib/program-levels";

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
  // Global-level fields: a global holder count, optionally gated by a
  // per-theatre minimum. Present only at the Global level.
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
  /**
   * How the row counts. Always present from the current API; optional here so
   * an older cached payload still renders. `"eachCountry"` only ever appears on
   * a Region or Country Set view.
   */
  aggregation?: Aggregation;
  // "eachCountry" rows only. For these, `attained`/`projectedAttained` are the
  // LOWEST per-country count (so `riskState` shades them correctly), and the
  // distinct holders across the whole area move to `pooledAttained`.
  pooledAttained?: number;
  projectedPooledAttained?: number;
  countriesMet?: number;
  countriesTotal?: number;
  projectedCountriesMet?: number;
  /** Every country in the area, zeros included, sorted by country. */
  countryBreakdown?: CountryBreakdownRow[];
  projectedCountryBreakdown?: CountryBreakdownRow[];
  /**
   * Country / Region / Country Set / Theatre views, Certification rows only:
   * people in the same population holding a current ILT/OLX that leads to this
   * certification but not the certification itself. Today's figure even under a
   * horizon; the area total on an "eachCountry" row. Absent everywhere else
   * (including older cached payloads), which is what hides the table row.
   */
  trainedNotCertified?: number;
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
  /** The specific training (fullTitle) this person holds — may be the primary
   *  requirement or one of its alternatives / a sibling variant. */
  training?: string;
  /** Every matching training this person holds, each with its own dates —
   *  the modal lists the person under each one. Absent on an older cached
   *  payload, which falls back to `training`. */
  holdings?: { training: string; completedDate: string; expiryDate: string }[];
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
  /** Optional only so an older cached payload still renders. */
  aggregation?: Aggregation;
  // Always present from the current API, and null unless the row is
  // "eachCountry" — in which case `attained` is the lowest country's count.
  pooledAttained?: number | null;
  projectedPooledAttained?: number | null;
  countriesMet?: number | null;
  countriesTotal?: number | null;
  projectedCountriesMet?: number | null;
  countryBreakdown?: CountryBreakdownRow[] | null;
  projectedCountryBreakdown?: CountryBreakdownRow[] | null;
  alternatives: AlternativeEntry[];
}

export interface TierInfo {
  name: string;
  sortOrder: number;
  specialisationsRequired: number;
  compliant: boolean;
  projectedCompliant: boolean | null;
  /**
   * "perTierPerSpecialisation" mode only: how many specialisations meet all of
   * this tier's criteria (achieved + the tier's deployment reqs for that spec).
   * null in the other modes, where the ladder-wide achieved count is shown.
   */
  satisfiedSpecialisationCount?: number | null;
  projectedSatisfiedSpecialisationCount?: number | null;
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

export type RiskState = "compliant" | "atRisk" | "nonCompliant";

/**
 * Classify a requirement's compliance taking the projection into account:
 *  - compliant: still meets the requirement at the selected horizon (or now)
 *  - atRisk: meets it now but falls below it by the horizon (amber)
 *  - nonCompliant: already below the requirement today (red)
 * When `projected` is undefined (no horizon) this reduces to the old
 * green/red split on the current attained figure.
 *
 * Exported (with RISK_TEXT/RISK_BADGE/AttainedValue/ExpiringNote) because the
 * Compliance Planning page renders the same amber "at risk" state — this is the
 * single definition of amber-vs-red, and a copy is how the two drifted before.
 */
export function riskState(attained: number, projected: number | undefined, required: number): RiskState {
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

export const RISK_TEXT: Record<RiskState, string> = {
  compliant: "text-green-700",
  atRisk: "text-amber-700",
  nonCompliant: "text-red-700",
};

export const RISK_BADGE: Record<RiskState, string> = {
  compliant: "bg-green-100 text-green-800",
  atRisk: "bg-amber-100 text-amber-800",
  nonCompliant: "bg-red-100 text-red-800",
};

/**
 * The export tone that matches each risk state, so a printed report shades a row
 * exactly as the page shades it. Kept beside RISK_TEXT/RISK_BADGE because those
 * three are the same decision expressed for three renderers.
 */
export const RISK_TONE: Record<RiskState, ReportTone> = {
  compliant: "green",
  atRisk: "amber",
  nonCompliant: "red",
};

/** "Met" / "At Risk" / "Not Met" — the wording on requirement and theatre badges. */
export const RISK_STATUS_LABEL: Record<RiskState, string> = {
  compliant: "Met",
  atRisk: "At Risk",
  nonCompliant: "Not Met",
};

/** "Compliant" / "At Risk" / "Not Compliant" — the wording on specialisation badges. */
export const RISK_COMPLIANCE_LABEL: Record<RiskState, string> = {
  compliant: "Compliant",
  atRisk: "At Risk",
  nonCompliant: "Not Compliant",
};

/**
 * The risk state of something the API has already judged compliant or not — a
 * specialisation, or a requirement whose per-theatre minimums a bare attained
 * count cannot express. Amber means the same thing it does in `riskState`:
 * compliant today, below the requirement by the selected horizon.
 */
export function complianceRiskState(
  compliant: boolean | null | undefined,
  projectedCompliant: boolean | null | undefined
): RiskState {
  if (!compliant) return "nonCompliant";
  return projectedCompliant === false ? "atRisk" : "compliant";
}

/**
 * "4 -> 2" when a projection lowers the count, "4" otherwise.
 *
 * The arrow is spelled in ASCII because this feeds the PDF, whose built-in
 * fonts are WinAnsi-encoded; `AttainedValue` draws the real glyph itself
 * because it can style the two halves separately, which a string cannot.
 */
export function attainedText(attained: number, projected?: number): string {
  return projected !== undefined && projected < attained
    ? `${attained} -> ${projected}`
    : `${attained}`;
}

/** "2 expiring", or nothing when the projection does not lower the count. */
export function expiringText(attained: number, projected?: number): string | undefined {
  if (projected === undefined || projected >= attained) return undefined;
  return `${attained - projected} expiring`;
}

/** A training type's display label, falling back to the raw value, then to a dash. */
export function trainingTypeLabel(trainingType: string | null | undefined): string {
  if (!trainingType) return "—";
  return TRAINING_TYPE_LABELS[trainingType] || trainingType;
}

/** The alternatives line as plain text: "or Training B (Certification), Training C (OLX)". */
export function alternativesText(alternatives: AlternativeEntry[] | undefined): string | undefined {
  if (!alternatives || alternatives.length === 0) return undefined;
  const parts = alternatives.map((a) => `${a.trainingFullTitle} (${trainingTypeLabel(a.trainingType)})`);
  return `or ${parts.join(", ")}`;
}

/** Whether a requirement must be met in every country of its area. */
export function isEachCountry(req: { aggregation?: Aggregation }): boolean {
  return req.aggregation === "eachCountry";
}

/** "Each country" / "Total" — the count mode as a table cell or export value. */
export function countModeLabel(aggregation: Aggregation | undefined): string {
  return AGGREGATION_SHORT_LABELS[aggregation ?? "total"];
}

/**
 * The Required cell's wording. An "each country" row reads "N per country"; a
 * pooled row on a multi-country view reads "N total", so the two modes cannot be
 * confused side by side; everything else keeps its unit ("N people").
 */
export function requiredText(
  req: { quantityRequired: number; aggregation?: Aggregation },
  level: string,
  unitLabel: string
): string {
  if (isEachCountry(req)) return `${req.quantityRequired} per country`;
  if (isMultiCountryScope(level)) return `${req.quantityRequired} total`;
  return `${req.quantityRequired} ${unitLabel}`.trim();
}

/** Whether a view scope ("region", "countrySet", …) spans several countries. */
export function isMultiCountryScope(level: string): boolean {
  const scope = parseScopeLevel(level);
  return scope !== null && isMultiCountryLevel(SCOPE_TO_REQ_LEVEL[scope]);
}

/**
 * "2 / 3 countries met", or "2 -> 1 / 3 countries met" when the projection loses
 * a country. ASCII arrow for the PDF, as in `attainedText`.
 */
export function countriesMetText(met: number, projectedMet: number | undefined | null, total: number): string {
  return `${attainedText(met, projectedMet ?? undefined)} / ${total} countries met`;
}

/**
 * The per-country breakdown as plain lines ("Country A: 4 -> 3 / 4 (At Risk, 1
 * expiring)"), for a PDF, which has no expander.
 */
export function countryBreakdownLines(
  breakdown: CountryBreakdownRow[] | null | undefined,
  projectedBreakdown: CountryBreakdownRow[] | null | undefined,
  required: number
): string[] | undefined {
  if (!breakdown || breakdown.length === 0) return undefined;
  return breakdown.map((c) => {
    const projected = projectedBreakdown?.find((p) => p.country === c.country)?.count;
    const expiring = expiringText(c.count, projected);
    const state = RISK_STATUS_LABEL[riskState(c.count, projected, required)];
    return `${c.country}: ${attainedText(c.count, projected)} / ${required} (${state}${expiring ? `, ${expiring}` : ""})`;
  });
}

/**
 * Why deployment requirements sit under a specialisation without deciding
 * whether it is achieved. Shared by both level reports and the PDF, so the
 * printed explanation cannot drift from the one on screen.
 */
export const DEPLOYMENT_REQUIREMENTS_NOTE =
  "Required together with the specialisation to qualify for tiers that use it. " +
  "These do not change whether the specialisation itself is achieved.";

/**
 * The specialisation gate for one tier. In "perTierPerSpecialisation" mode the
 * gate counts the specialisations meeting ALL of *this* tier's criteria rather
 * than the ladder-wide achieved count, so the two modes label it differently.
 */
export function tierGate(
  block: TierBlock,
  tier: TierInfo
): { label: string; counted: number; required: number; met: boolean } {
  const perTierPerSpec =
    block.deploymentMode === "perTierPerSpecialisation" && tier.satisfiedSpecialisationCount != null;
  const counted = perTierPerSpec
    ? tier.satisfiedSpecialisationCount ?? 0
    : block.achievedSpecialisationCount;
  return {
    label: perTierPerSpec ? "Specialisations meeting all criteria" : "Specialisations",
    counted,
    required: tier.specialisationsRequired,
    met: counted >= tier.specialisationsRequired,
  };
}

/** Inline "current → projected" attained value with an optional unit label. */
export function AttainedValue({
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
export function ExpiringNote({ attained, projected }: { attained: number; projected?: number }) {
  if (projected === undefined || projected >= attained) return null;
  return (
    <div className="text-[11px] text-amber-600 mt-0.5 font-medium">▼{attained - projected} expiring</div>
  );
}

/**
 * Side-by-side specialisation matrix (one column per specialisation, grouped
 * rows of Training / Required / Attained). Used wherever compliance is a count
 * of attained people: the Country, Region and Theatre levels, and the Global
 * level when it counts compliant theatres rather than holders.
 */
export function ComplianceTable({
  specialisations,
  level,
  filterValue,
  onViewStudents,
  onViewTrainedNotCertified,
  horizonMonths = 0,
  unitLabel,
}: {
  specialisations: Specialisation[];
  level: string;
  filterValue: string;
  onViewStudents: ViewStudentsFn;
  /** Opens the "Trained not certified" roster for a requirement. */
  onViewTrainedNotCertified?: ViewStudentsFn;
  /** The selected projection horizon; > 0 labels the trained-not-certified row as today's. */
  horizonMonths?: number;
  unitLabel: string;
}) {
  const maxReqs = Math.max(...specialisations.map((s) => s.requirements.length), 0);
  const maxDepReqs = Math.max(...specialisations.map((s) => s.deploymentRequirements?.length ?? 0), 0);
  const colCount = specialisations.length + 1;
  // The "Trained not certified" row appears only when the payload carries the
  // figure somewhere in this table, so the Global view and an older cached
  // payload render exactly as before.
  const showTrainedNotCertified = specialisations.some((s) =>
    [...s.requirements, ...(s.deploymentRequirements ?? [])].some((r) => r.trainedNotCertified !== undefined)
  );
  const tnc = showTrainedNotCertified ? { onView: onViewTrainedNotCertified, horizonMonths } : null;

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
              tnc={tnc}
            />
          ))}
          {maxDepReqs > 0 && (
            <>
              <tr>
                <td colSpan={colCount} className="px-4 py-2 border border-gray-200 bg-indigo-50">
                  <div className="text-sm font-semibold text-indigo-800">Deployment requirements</div>
                  <div className="text-xs text-indigo-700/80">{DEPLOYMENT_REQUIREMENTS_NOTE}</div>
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
                  tnc={tnc}
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
  tnc,
  deployment = false,
}: {
  reqIdx: number;
  specialisations: Specialisation[];
  level: string;
  filterValue: string;
  onViewStudents: ViewStudentsFn;
  unitLabel: string;
  /** Non-null when the table renders the "Trained not certified" row. */
  tnc: { onView?: ViewStudentsFn; horizonMonths: number } | null;
  deployment?: boolean;
}) {
  const reqsOf = (spec: Specialisation) =>
    deployment ? spec.deploymentRequirements ?? [] : spec.requirements;
  // Decided per row group, not per table: a group whose columns are all
  // Accreditations (or a deployment group with no Certification) would
  // otherwise render a row of dashes.
  const groupTnc =
    tnc && specialisations.some((spec) => reqsOf(spec)[reqIdx]?.trainedNotCertified !== undefined) ? tnc : null;
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
                  <div className="text-xs text-gray-500">{trainingTypeLabel(req.trainingType)}</div>
                  {req.alternatives && req.alternatives.length > 0 && (
                    <div className="text-xs text-blue-600 mt-1">
                      {req.alternatives.map((a, i) => (
                        <span key={i}>
                          {i === 0 ? "or " : ", "}<span className="font-medium">{a.trainingFullTitle}</span>
                          <span className="text-gray-400"> ({trainingTypeLabel(a.trainingType)})</span>
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
                <span className="font-semibold">{requiredText(req, level, unitLabel)}</span>
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
          if (isEachCountry(req)) {
            return (
              <td
                key={spec.name}
                className={`px-4 py-2 text-center border border-gray-200 align-top ${RISK_BG[state]}`}
              >
                <EachCountryAttained
                  req={req}
                  state={state}
                  onView={
                    level !== "global" && req.trainingTitle
                      ? () => onViewStudents(req.trainingTitle!, req.trainingFullTitle, level, filterValue, req.alternatives)
                      : undefined
                  }
                />
              </td>
            );
          }
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
      {/* Trained-not-certified row: an opportunity, not a compliance state, so
          it is never shaded green/red. */}
      {groupTnc && (
        <tr>
          <td className="px-4 py-2 font-medium text-gray-600 border border-gray-200">
            Trained not certified
            {groupTnc.horizonMonths > 0 && <div className="text-[11px] font-normal text-gray-400">as of today</div>}
          </td>
          {specialisations.map((spec) => {
            const req = reqsOf(spec)[reqIdx];
            const count = req?.trainedNotCertified;
            if (!req || count === undefined) {
              return (
                <td key={spec.name} className="px-4 py-2 text-center border border-gray-200">
                  <span className="text-gray-300">—</span>
                </td>
              );
            }
            const onView = groupTnc.onView;
            return (
              <td key={spec.name} className="px-4 py-2 text-center border border-gray-200">
                <span className={count > 0 ? "font-semibold text-amber-700" : "text-gray-500"}>
                  {count} {count === 1 ? "person" : "people"}
                </span>
                {onView && count > 0 && req.trainingTitle && (
                  <button
                    onClick={() => onView(req.trainingTitle!, req.trainingFullTitle, level, filterValue, req.alternatives)}
                    className="ml-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                  >
                    <Users size={12} /> View
                  </button>
                )}
                {isEachCountry(req) && <div className="text-[11px] text-gray-400 mt-0.5">across the area</div>}
              </td>
            );
          })}
        </tr>
      )}
      {/* Spacer row between requirement groups */}
      <tr>
        <td colSpan={specialisations.length + 1} className="h-1 bg-gray-100 border-0" />
      </tr>
    </>
  );
}

/**
 * One country's row of an "each country" breakdown: its count (current →
 * projected), whether it meets the quantity, and its own expiring note — the
 * headline has no single expiring figure, since each country drops separately.
 */
function CountryBreakdownList({
  breakdown,
  projectedBreakdown,
  required,
}: {
  breakdown: CountryBreakdownRow[];
  projectedBreakdown: CountryBreakdownRow[] | null | undefined;
  required: number;
}) {
  if (breakdown.length === 0) {
    return <p className="text-xs text-gray-500">No countries in this area.</p>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-gray-500">
          <th className="px-2 py-1 text-left font-medium">Country</th>
          <th className="px-2 py-1 text-center font-medium">Holders</th>
          <th className="px-2 py-1 text-center font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {breakdown.map((c) => {
          const projected = projectedBreakdown?.find((p) => p.country === c.country)?.count;
          const cState = riskState(c.count, projected, required);
          return (
            <tr key={c.country} className="border-t border-gray-200/70">
              <td className="px-2 py-1 text-left">{c.country}</td>
              <td className="px-2 py-1 text-center">
                <AttainedValue
                  attained={c.count}
                  projected={projected}
                  className={`font-semibold ${RISK_TEXT[cState]}`}
                />{" "}
                <span className="text-gray-400">/ {required}</span>
                <ExpiringNote attained={c.count} projected={projected} />
              </td>
              <td className="px-2 py-1 text-center">
                <span className={`inline-block px-1.5 py-0.5 rounded-full font-medium ${RISK_BADGE[cState]}`}>
                  {RISK_STATUS_LABEL[cState]}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The Attained cell of an "each country" requirement: how many of the area's
 * countries meet the quantity (current → projected), the lowest country's count
 * (the figure the row is shaded by), the pooled holder count for context, and an
 * expander listing every country.
 */
function EachCountryAttained({
  req,
  state,
  onView,
}: {
  req: Requirement;
  state: RiskState;
  onView?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const breakdown = req.countryBreakdown ?? [];
  const total = req.countriesTotal ?? breakdown.length;
  const met = req.countriesMet ?? breakdown.filter((c) => c.compliant).length;
  const projectedMet = req.projectedCountriesMet;
  const losing = projectedMet !== undefined && projectedMet < met ? met - projectedMet : 0;
  return (
    <div>
      <div className={`font-bold ${RISK_TEXT[state]}`}>
        <AttainedValue attained={met} projected={projectedMet} /> / {total} countries met
      </div>
      <div className="text-xs text-gray-600 mt-0.5">
        Lowest country: <AttainedValue attained={req.attained} projected={req.projectedAttained} />
        {req.pooledAttained !== undefined && (
          <span className="text-gray-400"> · {req.pooledAttained} holders in total</span>
        )}
      </div>
      {losing > 0 && (
        <div className="text-[11px] text-amber-600 mt-0.5 font-medium">
          ▼{losing} {losing === 1 ? "country falls" : "countries fall"} below by the horizon
        </div>
      )}
      <div className="mt-1 flex items-center justify-center gap-3">
        {breakdown.length > 0 && (
          <button
            onClick={() => setExpanded((p) => !p)}
            className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {expanded ? "Hide countries" : "Show countries"}
          </button>
        )}
        {onView && (
          <button onClick={onView} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
            <Users size={12} /> View
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-2 rounded border border-gray-200 bg-white/70">
          <CountryBreakdownList
            breakdown={breakdown}
            projectedBreakdown={req.projectedCountryBreakdown}
            required={req.quantityRequired}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Card layout for the Global level when requirements carry a per-theatre
 * minimum: one card per specialisation with a status badge and a table of
 * requirements, each expandable to a per-theatre breakdown.
 */
export function SpecialisationCard({ spec }: { spec: Specialisation }) {
  const deploymentReqs = spec.deploymentRequirements ?? [];
  const hasDeployment = deploymentReqs.length > 0;
  return (
    <div className="mb-6 bg-white rounded-lg border border-gray-200 overflow-hidden">
      {(() => {
        const state = complianceRiskState(spec.compliant, spec.projectedCompliant);
        const label = RISK_COMPLIANCE_LABEL[state];
        const depState = complianceRiskState(spec.deploymentCompliant, spec.projectedDeploymentCompliant);
        const depLabel = `Deployment: ${RISK_STATUS_LABEL[depState]}`;
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
                    <div className="text-xs text-indigo-700/80">{DEPLOYMENT_REQUIREMENTS_NOTE}</div>
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
  const statusState = complianceRiskState(req.compliant, req.projectedCompliant);
  const statusLabel = RISK_STATUS_LABEL[statusState];

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
                  <span className="text-gray-400"> ({trainingTypeLabel(a.trainingType)})</span>
                </span>
              ))}
            </div>
          )}
        </td>
        <td className="px-4 py-3 text-gray-600">{trainingTypeLabel(req.trainingType)}</td>
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
                    const tLabel = RISK_STATUS_LABEL[tState];
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

/**
 * The program/offering dashboards' export menu.
 *
 * This used to be a private second implementation of the same dropdown, and it
 * was missing the outside-click handler `ui/ExportMenu` has — so the panel
 * stayed open until you clicked the trigger again. It is now a thin adapter:
 * the flat `data`/`columns`/`filename` call shape these three pages use is
 * mapped onto the shared component's `onExport` callback, and the open flag is
 * passed straight through (a page renders several of these at once and owns
 * the state so only one is open at a time).
 *
 * `pdfDocument` is the escape hatch from that flat shape. A dashboard is not a
 * rectangle — it is cards, badges, risk shading and a tier ladder — and none of
 * that survives a single untoned table. A page that has assembled a
 * `ReportDocument` passes it here and the PDF is rendered from that instead.
 * CSV and Excel are untouched by it on purpose: they are data interchange, and
 * their contents have to keep matching what the flat `data`/`columns` produce.
 */
export function ExportMenu({
  show,
  setShow,
  data,
  columns,
  filename,
  align = "left",
  pdfDocument,
}: {
  show: boolean;
  setShow: (v: boolean) => void;
  data: Record<string, string | number>[];
  columns: { key: string; header: string }[];
  filename: string;
  align?: "left" | "right";
  /** When given, PDF export renders this document instead of the flat table.
   *  CSV and Excel continue to use `data`/`columns` unchanged. */
  pdfDocument?: ReportDocument | (() => ReportDocument);
}) {
  // Accepting a builder as well as a document lets a page defer assembling the
  // thing until a format is actually picked, which is what `ReportExportMenu`
  // already does — a dashboard rebuilds its document on every filter change
  // otherwise, for a menu most visits never open.
  const resolvePdfDocument = () =>
    typeof pdfDocument === "function" ? pdfDocument() : pdfDocument;

  const handleExport = (fmt: ExportFormat) => {
    if (fmt === "csv") {
      exportToCsv(data as never[], columns as never[], filename);
      return;
    }
    if (fmt === "excel") {
      exportToExcel(data as never[], columns as never[], filename);
      return;
    }
    const doc = resolvePdfDocument();
    if (doc) exportReportToPdf(doc, filename);
    else exportToPdf(data as never[], columns as never[], filename);
  };

  return (
    <SharedExportMenu show={show} setShow={setShow} align={align} onExport={handleExport} />
  );
}

/** @deprecated Use `components/ui/LoadingState`. Kept so existing call sites compile. */
export function LoadingSpinner() {
  return <LoadingState size="section" label="Loading…" />;
}

/**
 * One deployment requirement row inside a tier card (with per-theatre expand,
 * or — for an "each country" row — a per-country expand).
 */
function TierRequirementRow({ req, multiCountry }: { req: TierDeploymentRequirement; multiCountry: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const projected = req.projectedAttained ?? undefined;
  const state = riskState(req.attained, projected, req.quantityRequired);
  const eachCountry = isEachCountry(req);
  const countryBreakdown = req.countryBreakdown ?? [];
  const hasBreakdown = eachCountry
    ? countryBreakdown.length > 0
    : !!req.theatreBreakdown && req.theatreBreakdown.length > 0;
  const total = req.countriesTotal ?? countryBreakdown.length;
  const met = req.countriesMet ?? countryBreakdown.filter((c) => c.compliant).length;
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
          {eachCountry ? (
            <span className={`text-sm font-semibold ${RISK_TEXT[state]}`}>
              <AttainedValue attained={met} projected={req.projectedCountriesMet ?? undefined} /> / {total} countries
              <span className="font-normal text-gray-500"> · {req.quantityRequired} per country</span>
            </span>
          ) : (
            <span className={`text-sm font-semibold ${RISK_TEXT[state]}`}>
              <AttainedValue attained={req.attained} projected={projected} /> / {req.quantityRequired}
              {multiCountry && <span className="font-normal text-gray-500"> total</span>}
            </span>
          )}
          {hasBreakdown && (
            <button onClick={() => setExpanded((p) => !p)} className="text-gray-400 hover:text-gray-600">
              {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          )}
        </div>
      </div>
      {eachCountry ? (
        <div className="text-xs text-gray-600 mt-0.5">
          Lowest country: <AttainedValue attained={req.attained} projected={projected} />
          {req.pooledAttained != null && (
            <span className="text-gray-400"> · {req.pooledAttained} holders in total</span>
          )}
        </div>
      ) : (
        <ExpiringNote attained={req.attained} projected={projected} />
      )}
      {expanded && hasBreakdown && eachCountry && (
        <div className="mt-2 rounded border border-gray-200 bg-white/70">
          <CountryBreakdownList
            breakdown={countryBreakdown}
            projectedBreakdown={req.projectedCountryBreakdown}
            required={req.quantityRequired}
          />
        </div>
      )}
      {expanded && hasBreakdown && !eachCountry && (
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
 *
 * `level` is the view scope (optional, so existing callers are unaffected); on a
 * multi-country view it labels pooled deployment rows "total" beside the "per
 * country" ones.
 */
export function TierLadder({ block, level }: { block: TierBlock; level?: string }) {
  const multiCountry = level !== undefined && isMultiCountryScope(level);
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
          // In "perTierPerSpecialisation" mode the tier gate is how many
          // specialisations meet ALL of THIS tier's criteria (not the ladder-wide
          // achieved count), so use the tier's own satisfied count when present.
          const { counted, met: specsMet, label: specLabel } = tierGate(block, tier);
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
                  {specLabel}: {counted} / {tier.specialisationsRequired}
                </span>
                {!specsMet && (
                  <span className="ml-2 text-gray-500">
                    (need {tier.specialisationsRequired - counted} more)
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
                    <TierRequirementRow
                      key={`${req.trainingTitle ?? i}-${req.specialisationName ?? ""}`}
                      req={req}
                      multiCountry={multiCountry}
                    />
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
