"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Sparkles,
  Users,
  Zap,
  ClipboardCheck,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import {
  ExportMenu,
  AttainedValue,
  ExpiringNote,
  riskState,
  RISK_TEXT,
  RISK_BADGE,
  type RiskState,
} from "@/components/programs/ProgramCompliance";
import { ReportExportMenu } from "@/components/ui/ReportExportMenu";
import type { ReportDocument, ReportSection, ReportTableSection } from "@/lib/report-export";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";
import { useRegionData } from "@/hooks/useRegionData";
import { useTableSort } from "@/hooks/useTableSort";
import { useDebounce } from "@/hooks/useDebounce";
import { useFetchJson } from "@/hooks/useFetchJson";

// ── API shapes (mirror lib/compliance-plan.ts) ──
type CandidateTier = "renewal" | "easy-win" | "lapsed" | "legacy" | "net-new";

interface PlanRequirement {
  instanceId: string;
  specialisation: string | null;
  tierName: string | null;
  purpose: string;
  nativeLevel: string;
  scopeLabel: string;
  cert: string;
  required: number;
  attained: number;
  /** Holders left at the end of the renewal window; null when no window is set. */
  projectedAttained: number | null;
  shortfall: number;
  projectedShortfall: number | null;
  renewalPool: number;
  easyWinPool: number;
  lapsedPool: number;
  legacyPool: number;
  netNew: number;
  expiringSoon: number;
}
interface PlanSpecialisation {
  name: string;
  achieved: boolean;
  /** Still met at the end of the window; null when no window is set. */
  projectedAchieved: boolean | null;
  cost: number;
  easyWins: number;
  requirements: PlanRequirement[];
  chosen?: boolean;
}
interface PlanTargetResult {
  program: string;
  mode: "tier" | "specialisations" | "all";
  isTiered: boolean;
  tierName: string | null;
  headline: string;
  tierPlan?: { specialisationsRequired: number; alreadyAchieved: number; needed: number; deliveryCertShortfall: number };
  specialisations: PlanSpecialisation[];
  peopleMoves: number;
  easyWins: number;
  netNew: number;
}
interface PlanCandidateClose {
  program: string;
  specialisation: string | null;
  tierName: string | null;
  cert: string;
  scopeLabel: string;
  tier: CandidateTier;
  path: string | null;
}
interface PlanCandidate {
  email: string;
  fullName: string;
  country: string;
  theatre: string;
  topTier: CandidateTier;
  closesCount: number;
  closes: PlanCandidateClose[];
}
interface PlanRiskImpact {
  program: string;
  specialisation: string | null;
  tierName: string | null;
  cert: string;
  scopeLabel: string;
  required: number;
  attained: number;
  projectedAttained: number;
}
interface PlanRenewalRow {
  email: string;
  fullName: string;
  country: string;
  theatre: string;
  cert: string;
  scopeLabel: string;
}
interface CompliancePlanResult {
  scopeLabel: string;
  renewalWindowMonths: number;
  planForWindow: boolean;
  targets: PlanTargetResult[];
  candidates: PlanCandidate[];
  eligible: PlanCandidate[];
  renewals: PlanRenewalRow[];
  riskImpacts: PlanRiskImpact[];
  totals: {
    peopleMoves: number;
    easyWins: number;
    lapsed: number;
    legacy: number;
    netNew: number;
    renewalMoves: number;
    renewalsAtRisk: number;
  };
}
interface PlanningOption {
  name: string;
  isTiered: boolean;
  levels: string[];
  tiers: string[];
  specialisations: string[];
}

type ScopeLevel = "global" | "theatre" | "region" | "country";

interface TargetSelection {
  mode: "tier" | "specialisations" | "all";
  tier: string;
  specialisations: string[];
}

const TIER_LABEL: Record<CandidateTier, string> = {
  renewal: "Renewal (expiring)",
  "easy-win": "Easy win",
  lapsed: "Lapsed (renew)",
  legacy: "Legacy upgrade",
  "net-new": "Net-new",
};
const TIER_BADGE: Record<CandidateTier, string> = {
  // Orange, not amber: `lapsed` already owns amber and the two are semantically
  // adjacent, so they have to stay visually separable.
  renewal: "bg-orange-100 text-orange-800",
  "easy-win": "bg-green-100 text-green-800",
  lapsed: "bg-amber-100 text-amber-800",
  legacy: "bg-indigo-100 text-indigo-800",
  "net-new": "bg-gray-100 text-gray-700",
};

/** Row tints for the roadmap table — lighter than the dashboard's cell shading. */
const ROW_BG: Record<RiskState, string> = {
  compliant: "",
  atRisk: "bg-amber-50/40",
  nonCompliant: "bg-red-50/40",
};

// ── Reusable export section builders ───────────────────────────────────────
// Shared by the per-section ExportMenus and the page-level "Export report"
// (ReportExportMenu) so the two surfaces can never drift.

/** Distinct specialisations a candidate would help fulfil, across all their gaps. */
function candidateSpecialisations(c: PlanCandidate): string {
  return [...new Set(c.closes.map((cl) => cl.specialisation).filter((s): s is string => !!s))].join(", ");
}
/**
 * The qualifying training a candidate already holds that gives them a head-start —
 * the ILT/OLX behind an easy win (or the legacy cert behind a legacy upgrade).
 */
function candidateHelpfulTraining(c: PlanCandidate): string {
  return [...new Set(c.closes.map((cl) => cl.path).filter((p): p is string => !!p))].join(", ");
}

// Single source of truth for the plain-language explanation of one gap a candidate
// would close, worded per tier. `closeSegments` returns the sentence as ordered
// pieces so both the on-screen `CloseSentence` (which bolds names) and the export
// (`closeSentenceText`, plain) render the exact same wording and can't drift.
function closeSegments(cl: PlanCandidateClose): { text: string; bold?: boolean }[] {
  const goal: { text: string; bold?: boolean }[] = cl.specialisation
    ? [{ text: "the " }, { text: cl.specialisation, bold: true }, { text: " specialisation" }]
    : cl.tierName
      ? [{ text: "the " }, { text: cl.tierName, bold: true }, { text: " tier" }]
      : [{ text: "this requirement" }];
  const cert = { text: cl.cert, bold: true };
  switch (cl.tier) {
    case "renewal":
      return [
        { text: "They hold " }, cert,
        { text: ", but it expires within the renewal window. Renewing it keeps " }, ...goal,
        { text: " compliant." },
      ];
    case "easy-win":
      return [
        { text: "They have taken " }, { text: cl.path ?? "the required training", bold: true },
        { text: ". Passing the " }, cert, { text: " certification exam will contribute to " },
        ...goal, { text: "." },
      ];
    case "lapsed":
      return [
        { text: "They previously held " }, cert,
        { text: ", but it has expired. Renewing it will contribute to " }, ...goal, { text: "." },
      ];
    case "legacy":
      return [
        { text: "They hold the legacy certification " }, { text: cl.path ?? "a superseded certification", bold: true },
        { text: ". Upgrading to " }, cert, { text: " will contribute to " }, ...goal, { text: "." },
      ];
    default:
      return [
        { text: "Passing the " }, cert, { text: " certification exam will contribute to " }, ...goal, { text: "." },
      ];
  }
}

/** Plain-text form of a close explanation (for exports). */
function closeSentenceText(cl: PlanCandidateClose): string {
  return closeSegments(cl).map((s) => s.text).join("");
}

function buildCandidateSection(candidates: PlanCandidate[], title = "Who to certify"): ReportTableSection {
  return {
    title,
    columns: [
      { key: "Name", header: "Name" }, { key: "Email", header: "Email" },
      { key: "Country", header: "Country" }, { key: "Theatre", header: "Theatre" },
      { key: "Tier", header: "Best move" },
      { key: "Specialisation", header: "Specialisation" },
      { key: "Relevant training", header: "Relevant training held" },
      { key: "Gaps closed", header: "Gaps closed" },
      { key: "Detail", header: "Detail" },
    ],
    rows: candidates.map((c) => ({
      Name: c.fullName,
      Email: c.email,
      Country: c.country,
      Theatre: c.theatre,
      Tier: TIER_LABEL[c.topTier],
      Specialisation: candidateSpecialisations(c),
      "Relevant training": candidateHelpfulTraining(c),
      "Gaps closed": c.closesCount,
      Detail: c.closes
        .map((cl) => `${closeSentenceText(cl)} (${cl.program} · ${cl.scopeLabel})`)
        .join("\n"),
    })),
  };
}

function buildRenewalSection(renewals: PlanRenewalRow[], windowMonths: number): ReportTableSection {
  return {
    title: "Renewals at risk",
    subtitle: `Expiring within ${windowMonths} month${windowMonths === 1 ? "" : "s"}`,
    columns: [
      { key: "Name", header: "Name" }, { key: "Email", header: "Email" },
      { key: "Country", header: "Country" }, { key: "Theatre", header: "Theatre" },
      { key: "Cert", header: "Cert" }, { key: "Scope", header: "Scope" },
    ],
    rows: renewals.map((r) => ({
      Name: r.fullName, Email: r.email, Country: r.country,
      Theatre: r.theatre, Cert: r.cert, Scope: r.scopeLabel,
    })),
  };
}

function buildSummarySection(plan: CompliancePlanResult): ReportTableSection {
  return {
    title: "Summary",
    columns: [{ key: "Metric", header: "Metric" }, { key: "Value", header: "Value" }],
    rows: [
      { Metric: "People to certify", Value: plan.totals.peopleMoves },
      { Metric: "Easy wins", Value: plan.totals.easyWins },
      { Metric: "Lapsed (renew)", Value: plan.totals.lapsed },
      { Metric: "Legacy upgrade", Value: plan.totals.legacy },
      { Metric: "Net-new training", Value: plan.totals.netNew },
      // Two different things: holders whose training lapses in the window, vs the
      // subset the plan has costed as renewals. Labelled so they don't read as additive.
      { Metric: "Renewals at risk (holders expiring)", Value: plan.totals.renewalsAtRisk },
      ...(plan.planForWindow
        ? [{ Metric: "Renewals included in plan", Value: plan.totals.renewalMoves }]
        : []),
    ],
  };
}

function buildRoadmapSection(
  targets: PlanTargetResult[],
  windowMonths: number,
  planForWindow: boolean,
): ReportTableSection {
  const rows: Record<string, string | number>[] = [];
  for (const t of targets) {
    const target = t.tierName ?? (t.mode === "all" ? "All requirements" : "Specialisations");
    for (const s of t.specialisations) {
      for (const r of s.requirements) {
        rows.push({
          program: t.program,
          target,
          specialisation: s.name,
          achieved: s.achieved ? "Yes" : "No",
          cert: r.cert,
          scope: r.scopeLabel,
          attained: r.attained,
          required: r.required,
          gap: r.shortfall,
          ...(windowMonths > 0
            ? {
                projectedAttained: r.projectedAttained ?? r.attained,
                expiringSoon: r.expiringSoon,
                projectedGap: r.projectedShortfall ?? r.shortfall,
                projectedAchieved: s.projectedAchieved === false ? "No" : "Yes",
              }
            : {}),
          ...(planForWindow ? { renewals: r.renewalPool } : {}),
          easy: r.easyWinPool,
          lapsed: r.lapsedPool,
          legacy: r.legacyPool,
          netNew: r.netNew,
        });
      }
    }
  }
  return {
    title: "Roadmap",
    columns: [
      { key: "program", header: "Program" },
      { key: "target", header: "Target" },
      { key: "specialisation", header: "Specialisation" },
      { key: "achieved", header: "Achieved" },
      { key: "cert", header: "Requirement" },
      { key: "scope", header: "Scope" },
      { key: "attained", header: "Attained" },
      { key: "required", header: "Required" },
      { key: "gap", header: "Gap" },
      // Only meaningful with a window selected — at Off these are constant noise.
      ...(windowMonths > 0
        ? [
            { key: "projectedAttained", header: `Projected (+${windowMonths}mo)` },
            { key: "expiringSoon", header: "Expiring" },
            { key: "projectedGap", header: "Projected gap" },
            { key: "projectedAchieved", header: "Projected achieved" },
          ]
        : []),
      ...(planForWindow ? [{ key: "renewals", header: "Renewals" }] : []),
      { key: "easy", header: "Easy wins" },
      { key: "lapsed", header: "Lapsed" },
      { key: "legacy", header: "Legacy" },
      { key: "netNew", header: "Net-new" },
    ],
    rows,
  };
}

function buildRiskImpactSection(impacts: PlanRiskImpact[], windowMonths: number): ReportTableSection {
  return {
    title: "Requirements at risk",
    subtitle: `Falling below target within ${windowMonths} month${windowMonths === 1 ? "" : "s"} as training expires`,
    columns: [
      { key: "Program", header: "Program" },
      { key: "Specialisation", header: "Specialisation" },
      { key: "Requirement", header: "Requirement" },
      { key: "Scope", header: "Scope" },
      { key: "Attained", header: "Attained" },
      { key: "Projected", header: "Projected" },
      { key: "Required", header: "Required" },
      { key: "Shortfall", header: "Projected shortfall" },
    ],
    rows: impacts.map((i) => ({
      Program: i.program,
      Specialisation: i.specialisation ?? i.tierName ?? "",
      Requirement: i.cert,
      Scope: i.scopeLabel,
      Attained: i.attained,
      Projected: i.projectedAttained,
      Required: i.required,
      Shortfall: Math.max(0, i.required - i.projectedAttained),
    })),
  };
}

/** Assemble the whole Compliance Planning page into one exportable report. */
function buildPlanDocument(plan: CompliancePlanResult, level: ScopeLevel): ReportDocument {
  const sections: ReportSection[] = [
    buildSummarySection(plan),
    buildRoadmapSection(plan.targets, plan.renewalWindowMonths, plan.planForWindow),
    buildCandidateSection(plan.candidates),
  ];
  if (plan.eligible.length > 0) {
    sections.push(buildCandidateSection(plan.eligible, "All eligible candidates"));
  }
  if (plan.riskImpacts.length > 0) {
    sections.push(buildRiskImpactSection(plan.riskImpacts, plan.renewalWindowMonths));
  }
  if (plan.renewals.length > 0) {
    sections.push(buildRenewalSection(plan.renewals, plan.renewalWindowMonths));
  }
  return {
    title: "Compliance Planning",
    meta: [
      { label: "Scope", value: plan.scopeLabel },
      { label: "Level", value: level },
      {
        label: "Renewal window",
        value: plan.renewalWindowMonths === 0 ? "Off" : `${plan.renewalWindowMonths} month${plan.renewalWindowMonths === 1 ? "" : "s"}`,
      },
      {
        label: "Planning mode",
        value: plan.planForWindow
          ? `Planning for the ${plan.renewalWindowMonths}-month window`
          : "Status projection only",
      },
      { label: "Generated", value: new Date().toLocaleString() },
    ],
    sections,
  };
}

export default function CompliancePlanningPage() {
  const companyScope = useCompanyScope();
  const { rows: regionRows } = useRegionData();

  // Compliance is per-company — derive a single-company selection (like the
  // dashboards), defaulting to the first company when "all" is selected.
  const companyId = useMemo<number | null>(() => {
    if (companyScope.loading) return null;
    if (companyScope.selected !== "all") return companyScope.selected;
    return companyScope.companies[0]?.id ?? null;
  }, [companyScope.loading, companyScope.selected, companyScope.companies]);

  // Selector metadata.
  const [options, setOptions] = useState<PlanningOption[]>([]);
  useEffect(() => {
    fetch("/api/programs/planning?options=true")
      .then((r) => r.json())
      .then((d) => setOptions(d.programs || []))
      .catch(() => {});
  }, []);

  // Scope.
  const [level, setLevel] = useState<ScopeLevel>("global");
  const [scopeValue, setScopeValue] = useState("");
  const theatres = useMemo(() => [...new Set(regionRows.map((r) => r.theatre).filter((t): t is string => !!t))].sort(), [regionRows]);
  const regions = useMemo(() => [...new Set(regionRows.map((r) => r.region).filter(Boolean))].sort(), [regionRows]);
  const countries = useMemo(() => [...new Set(regionRows.map((r) => r.country))].sort(), [regionRows]);
  const scopeOptions = level === "theatre" ? theatres : level === "region" ? regions : level === "country" ? countries : [];

  // Targets: program name → selection (only selected programs are keys).
  const [targets, setTargets] = useState<Record<string, TargetSelection>>({});
  const [renewalWindowMonths, setRenewalWindowMonths] = useState(3);
  const [planForWindow, setPlanForWindow] = useState(false);
  const [showReportExport, setShowReportExport] = useState(false);

  const toggleProgram = (name: string, isTiered: boolean) => {
    setTargets((prev) => {
      const next = { ...prev };
      if (next[name]) delete next[name];
      else next[name] = { mode: isTiered ? "tier" : "all", tier: "", specialisations: [] };
      return next;
    });
  };
  const updateTarget = (name: string, patch: Partial<TargetSelection>) =>
    setTargets((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));

  // Build the targets payload for the API.
  const targetsPayload = useMemo(() => {
    return Object.entries(targets)
      .map(([program, sel]) => {
        if (sel.mode === "tier") return { program, mode: "tier", tier: sel.tier };
        if (sel.mode === "specialisations") return { program, mode: "specialisations", specialisations: sel.specialisations };
        return { program, mode: "all" };
      })
      .filter((t) => t.mode !== "tier" || !!t.tier)
      .filter((t) => t.mode !== "specialisations" || (t.specialisations && t.specialisations.length > 0));
  }, [targets]);

  const scopeReady = level === "global" || !!scopeValue;
  const debouncedPayload = useDebounce(JSON.stringify(targetsPayload), 400);
  const debouncedTargets = useMemo<unknown[]>(() => {
    try {
      const parsed = JSON.parse(debouncedPayload);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [debouncedPayload]);

  // Build the plan URL (null when the selection is incomplete → no fetch). Reading
  // the data through useFetchJson keeps the loading state derived, avoiding a
  // synchronous setState inside an effect.
  const active = companyId !== null && scopeReady && debouncedTargets.length > 0;
  const planUrl = useMemo(() => {
    if (!active) return null;
    const params = new URLSearchParams();
    params.set("targets", debouncedPayload);
    params.set("level", level);
    if (level === "theatre") params.set("theatre", scopeValue);
    if (level === "region") params.set("region", scopeValue);
    if (level === "country") params.set("country", scopeValue);
    params.set("companyId", String(companyId));
    params.set("renewalWindowMonths", String(renewalWindowMonths));
    params.set("planForWindow", String(planForWindow && renewalWindowMonths > 0));
    return `/api/programs/planning?${params.toString()}`;
  }, [active, debouncedPayload, level, scopeValue, companyId, renewalWindowMonths, planForWindow]);

  const { data: plan, loading } = useFetchJson<CompliancePlanResult>(planUrl, { enabled: active });

  const kpis = plan
    ? [
        {
          label: "People to certify",
          value: plan.totals.peopleMoves,
          icon: Users,
          tone: "blue" as const,
          hint:
            plan.planForWindow && plan.totals.renewalMoves > 0
              ? `Incl. ${plan.totals.renewalMoves} renewal${plan.totals.renewalMoves === 1 ? "" : "s"}`
              : undefined,
        },
        { label: "Easy wins", value: plan.totals.easyWins, icon: Zap, tone: "green" as const, hint: "Just need the exam" },
        { label: "Net-new training", value: plan.totals.netNew, icon: ClipboardCheck, tone: "indigo" as const },
        {
          label: "Renewals at risk",
          value: plan.totals.renewalsAtRisk,
          icon: RefreshCw,
          tone: "amber" as const,
          hint: plan.planForWindow ? "Counted in the plan" : `Expire within ${plan.renewalWindowMonths}mo`,
        },
      ]
    : [];

  return (
    <div>
      <PageHeader
        title="Compliance Planning"
        helpSlug="compliance-planning"
        showBack
        rightContent={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-600">
              Renewal window
              <select
                value={renewalWindowMonths}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  setRenewalWindowMonths(n);
                  // Clear rather than leave the checkbox ticked-but-inert.
                  if (n === 0) setPlanForWindow(false);
                }}
                className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
              >
                <option value={0}>Off</option>
                <option value={1}>1 month</option>
                <option value={3}>3 months</option>
                <option value={6}>6 months</option>
                <option value={12}>12 months</option>
              </select>
            </label>
            <label
              className={`flex items-center gap-2 text-sm ${renewalWindowMonths === 0 ? "text-gray-400" : "text-gray-600"}`}
              title="Count the renewals needed to stay compliant through the window as gaps to close — People to certify and Who to certify will include them."
            >
              <input
                type="checkbox"
                checked={planForWindow}
                disabled={renewalWindowMonths === 0}
                onChange={(e) => setPlanForWindow(e.target.checked)}
                className="rounded border-gray-300"
              />
              Plan for this window
            </label>
            {active && !loading && plan && (
              <ReportExportMenu
                show={showReportExport}
                setShow={setShowReportExport}
                document={() => buildPlanDocument(plan, level)}
                filename={`compliance-plan-${plan.scopeLabel}${
                  plan.renewalWindowMonths > 0 ? `-plus${plan.renewalWindowMonths}mo` : ""
                }${plan.planForWindow ? "-planned" : ""}`}
                align="right"
              />
            )}
          </div>
        }
      />

      {/* Controls */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-700 mr-1">Scope</span>
          <select
            value={level}
            onChange={(e) => { setLevel(e.target.value as ScopeLevel); setScopeValue(""); }}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white"
          >
            <option value="global">Global</option>
            <option value="theatre">By Theatre</option>
            <option value="region">By Region</option>
            <option value="country">By Country</option>
          </select>
          {level !== "global" && (
            <select
              value={scopeValue}
              onChange={(e) => setScopeValue(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white"
            >
              <option value="">Select {level}…</option>
              {scopeOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
        </div>

        <div>
          <div className="text-sm font-medium text-gray-700 mb-2">Programs &amp; targets</div>
          {options.length === 0 ? (
            <div className="text-sm text-gray-500">
              No programs configured. Add requirements in{" "}
              <Link href="/admin/program-data" className="text-blue-600 hover:underline">Admin › Program Data</Link>.
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {options.map((opt) => {
                const sel = targets[opt.name];
                return (
                  <div key={opt.name} className={`rounded-lg border p-3 ${sel ? "border-blue-300 bg-blue-50/40" : "border-gray-200"}`}>
                    <label className="flex items-center gap-2 font-medium text-sm cursor-pointer">
                      <input type="checkbox" checked={!!sel} onChange={() => toggleProgram(opt.name, opt.isTiered)} />
                      {opt.name}
                      {opt.isTiered && <span className="text-xs text-indigo-600 font-normal">tiered</span>}
                    </label>
                    {sel && (
                      <div className="mt-2 pl-6 space-y-2">
                        <select
                          value={sel.mode}
                          onChange={(e) => updateTarget(opt.name, { mode: e.target.value as TargetSelection["mode"] })}
                          className="border border-gray-300 rounded-lg px-2 py-1 text-sm bg-white w-full"
                        >
                          {opt.isTiered && <option value="tier">Target a tier (cheapest specialisations)</option>}
                          <option value="specialisations">Specific specialisation(s)</option>
                          {!opt.isTiered && <option value="all">All requirements</option>}
                        </select>
                        {sel.mode === "tier" && (
                          <select
                            value={sel.tier}
                            onChange={(e) => updateTarget(opt.name, { tier: e.target.value })}
                            className="border border-gray-300 rounded-lg px-2 py-1 text-sm bg-white w-full"
                          >
                            <option value="">Select tier…</option>
                            {opt.tiers.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        )}
                        {sel.mode === "specialisations" && (
                          <div className="flex flex-wrap gap-1.5">
                            {opt.specialisations.length === 0 && <span className="text-xs text-gray-400">No specialisations.</span>}
                            {opt.specialisations.map((s) => {
                              const on = sel.specialisations.includes(s);
                              return (
                                <button
                                  key={s}
                                  onClick={() => updateTarget(opt.name, {
                                    specialisations: on ? sel.specialisations.filter((x) => x !== s) : [...sel.specialisations, s],
                                  })}
                                  className={`px-2 py-0.5 rounded-full text-xs border ${on ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
                                >
                                  {s}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      {active && loading && (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      )}

      {active && !loading && plan && (
        <>
          {/* Projection explainer — mirrors the program dashboard's horizon banner.
              Reads the window off the payload, not local state, so it can never
              describe a projection the table below it isn't showing yet. */}
          {plan.renewalWindowMonths > 0 && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
              <span className="font-medium">Projection:</span>
              <span>
                Requirements shaded <span className="font-medium text-amber-700">amber</span> are met today but fall
                below target within <strong>{plan.renewalWindowMonths} month{plan.renewalWindowMonths === 1 ? "" : "s"}</strong>{" "}
                as training expires (shown as current → projected).{" "}
                {plan.planForWindow
                  ? "The renewals needed to hold them are counted in the plan below."
                  : "Tick “Plan for this window” to count the renewals needed to hold them."}
              </span>
            </div>
          )}

          <KpiStrip cards={kpis} />

          {/* Aggregate roadmap. Keyed by the projection because SpecBlock's
              collapse default is a mount-only useState initialiser — without this
              a spec that becomes at-risk would stay collapsed. */}
          <div className="space-y-4 mb-6">
            {plan.targets.map((t) => (
              <TargetCard
                key={`${t.program}-${plan.renewalWindowMonths}-${plan.planForWindow}`}
                target={t}
                windowMonths={plan.renewalWindowMonths}
              />
            ))}
          </div>

          {/* Candidate-centric drill-down */}
          <CandidateTable candidates={plan.candidates} scopeLabel={plan.scopeLabel} />

          {/* Full eligible pool (superset of the nominated candidates) */}
          {plan.eligible.length > 0 && (
            <CandidateTable
              candidates={plan.eligible}
              scopeLabel={plan.scopeLabel}
              title="All eligible candidates"
              subtitle="Everyone who already holds qualifying training and could be certified — the plan above recommends the cheapest subset to close the gaps."
              filenameKind="eligible"
              countLabel="Could close"
              emptyText="No eligible candidates — remaining gaps need brand-new training."
            />
          )}

          {/* Renewal-at-risk */}
          {plan.renewals.length > 0 && (
            <RenewalTable
              renewals={plan.renewals}
              impacts={plan.riskImpacts}
              windowMonths={plan.renewalWindowMonths}
              planForWindow={plan.planForWindow}
              scopeLabel={plan.scopeLabel}
            />
          )}
        </>
      )}

      {!active && (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          <Sparkles className="mx-auto mb-2 text-blue-400" size={28} />
          {debouncedTargets.length === 0
            ? "Select one or more programs and a target above to generate a gap-closing plan."
            : `Choose a ${level} to plan against.`}
        </div>
      )}
    </div>
  );
}

// ── Roadmap card for one target ──
function TargetCard({ target, windowMonths }: { target: PlanTargetResult; windowMonths: number }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            {target.program}
            {target.tierName && <span className="ml-2 text-sm font-normal text-indigo-600">→ {target.tierName}</span>}
          </h2>
          <p className="text-sm text-gray-600 mt-1">{target.headline}</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium text-blue-700">{target.peopleMoves} to certify</span>
          {target.easyWins > 0 && <span className="text-green-700">{target.easyWins} easy</span>}
          {target.netNew > 0 && <span className="text-gray-500">{target.netNew} net-new</span>}
        </div>
      </div>

      {target.tierPlan && (
        <div className="mt-3 text-xs text-gray-500">
          Specialisations: {target.tierPlan.alreadyAchieved}/{target.tierPlan.specialisationsRequired} achieved
          {target.tierPlan.needed > 0 && ` — need ${target.tierPlan.needed} more`}
          {target.tierPlan.deliveryCertShortfall > 0 && ` · ${target.tierPlan.deliveryCertShortfall} delivery-cert people short`}
        </div>
      )}

      <div className="mt-4 space-y-3">
        {target.specialisations.map((s) => (
          <SpecBlock key={s.name} spec={s} tiered={!!target.tierPlan} windowMonths={windowMonths} />
        ))}
      </div>
    </div>
  );
}

function SpecBlock({
  spec,
  tiered,
  windowMonths,
}: {
  spec: PlanSpecialisation;
  tiered: boolean;
  windowMonths: number;
}) {
  // Achieved today but not at the horizon = at risk. Same three-way split the
  // program dashboard uses, so the two pages colour identically.
  const state: RiskState = spec.achieved
    ? spec.projectedAchieved === false
      ? "atRisk"
      : "compliant"
    : "nonCompliant";
  // An at-risk block starts open — hiding the lapse behind a collapsed card is
  // exactly the problem this is here to fix.
  const [open, setOpen] = useState(state !== "compliant");
  const dim = tiered && spec.chosen === false && state === "compliant";
  const tint =
    state === "compliant"
      ? "border-green-200 bg-green-50/50"
      : state === "atRisk"
        ? "border-amber-200 bg-amber-50/50"
        : "border-gray-200";
  return (
    <div className={`rounded-lg border ${tint} ${dim ? "opacity-60" : ""}`}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="flex items-center gap-2 text-sm font-medium">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {spec.name}
          {spec.achieved && <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-800">Achieved</span>}
          {state === "atRisk" && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${RISK_BADGE.atRisk}`}>
              At risk in {windowMonths}mo
            </span>
          )}
          {tiered && spec.chosen && !spec.achieved && <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800">Recommended</span>}
        </span>
        <span className="text-xs text-gray-500">
          {spec.cost > 0 ? `${spec.cost} to certify` : "—"}{spec.easyWins > 0 ? ` · ${spec.easyWins} easy` : ""}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                  <th className="py-1 pr-3 font-medium">Requirement</th>
                  <th className="py-1 pr-3 font-medium">Scope</th>
                  <th className="py-1 pr-3 font-medium">Have / Need</th>
                  <th className="py-1 pr-3 font-medium">Gap</th>
                  <th className="py-1 font-medium">Candidates</th>
                </tr>
              </thead>
              <tbody>
                {spec.requirements.map((r) => (
                  <ReqRow key={r.instanceId} r={r} windowMonths={windowMonths} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ReqRow({ r, windowMonths }: { r: PlanRequirement; windowMonths: number }) {
  const projected = r.projectedAttained ?? undefined;
  const state = riskState(r.attained, projected, r.required);
  const projectedGap = r.projectedShortfall ?? r.shortfall;
  const hasCandidates =
    r.renewalPool > 0 || r.easyWinPool > 0 || r.lapsedPool > 0 || r.legacyPool > 0 || r.netNew > 0;
  return (
    <tr className={`border-b border-gray-50 ${ROW_BG[state]}`}>
      <td className="py-1.5 pr-3">{r.cert}</td>
      <td className="py-1.5 pr-3">{r.scopeLabel}</td>
      {/* The expiry marker lives here, under the numbers it changes — not beside
          the scope label, where it read as a property of the geography. */}
      <td className={`py-1.5 pr-3 ${RISK_TEXT[state]}`}>
        <AttainedValue attained={r.attained} projected={projected} /> / {r.required}
        <ExpiringNote attained={r.attained} projected={projected} />
      </td>
      <td className="py-1.5 pr-3">
        {state === "compliant" && <span className="text-green-600">✓</span>}
        {state === "atRisk" && (
          <span className="font-medium text-amber-700">
            ✓ now · need {projectedGap} in {windowMonths}mo
          </span>
        )}
        {state === "nonCompliant" && (
          <>
            <span className="font-medium text-red-700">need {r.shortfall}</span>
            {projectedGap > r.shortfall && (
              <div className="text-[11px] text-amber-600 mt-0.5 font-medium">
                → {projectedGap} in {windowMonths}mo
              </div>
            )}
          </>
        )}
      </td>
      <td className="py-1.5 text-xs text-gray-600">
        {!hasCandidates ? "—" : (
          <span className="flex flex-wrap gap-1">
            {r.renewalPool > 0 && <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-800">{r.renewalPool} renewals</span>}
            {r.easyWinPool > 0 && <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-800">{r.easyWinPool} easy</span>}
            {r.lapsedPool > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">{r.lapsedPool} lapsed</span>}
            {r.legacyPool > 0 && <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800">{r.legacyPool} legacy</span>}
            {r.netNew > 0 && <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{r.netNew} net-new</span>}
          </span>
        )}
      </td>
    </tr>
  );
}

// Plain-language explanation of a single gap a candidate would close, worded to
// match their circumstance (easy win via training already taken, a lapsed renewal,
// or a legacy upgrade). Renders the shared `closeSegments` wording (bolding names)
// so it always matches the export's `closeSentenceText`.
function CloseSentence({ cl }: { cl: PlanCandidateClose }) {
  return (
    <div className="flex flex-col">
      <span>
        {closeSegments(cl).map((s, i) =>
          s.bold ? <strong key={i}>{s.text}</strong> : <Fragment key={i}>{s.text}</Fragment>,
        )}
      </span>
      <span className="text-[11px] text-gray-400">
        {cl.program} · {cl.scopeLabel}
      </span>
    </div>
  );
}

// ── Candidate-centric drill-down ──
// Renders either the nominated "Who to certify" subset or the full "All eligible
// candidates" pool — same columns, sorting, drill-down and export.
function CandidateTable({
  candidates,
  scopeLabel,
  title = "Who to certify",
  subtitle = "These people are the cheapest to certify — most have already done the required training and just need to sit the exam.",
  filenameKind = "candidates",
  countLabel = "Gaps closed",
  emptyText = "No named candidates — remaining gaps need brand-new training (net-new), or everything is already met.",
}: {
  candidates: PlanCandidate[];
  scopeLabel: string;
  title?: string;
  subtitle?: string;
  filenameKind?: string;
  countLabel?: string;
  emptyText?: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showExport, setShowExport] = useState(false);

  const { sorted, toggleSort, sortIndicator } = useTableSort(candidates, {
    fullName: (c) => c.fullName,
    country: (c) => c.country,
    theatre: (c) => c.theatre,
    topTier: (c) => c.topTier,
    specialisation: (c) => candidateSpecialisations(c),
    training: (c) => candidateHelpfulTraining(c),
    closesCount: (c) => c.closesCount,
  }, { defaultKey: "topTier", tiebreakKey: "fullName", descFirstKeys: ["closesCount"] });

  const exportSection = buildCandidateSection(candidates, title);

  const toggle = (email: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(email)) next.delete(email); else next.add(email);
    return next;
  });

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">{title} ({candidates.length})</h2>
          <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
        </div>
        {candidates.length > 0 && (
          <ExportMenu show={showExport} setShow={setShowExport} data={exportSection.rows} columns={exportSection.columns} filename={`compliance-plan-${filenameKind}-${scopeLabel}`} align="right" />
        )}
      </div>
      {candidates.length === 0 ? (
        <p className="text-sm text-gray-500">{emptyText}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("fullName")}>Name{sortIndicator("fullName")}</th>
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("country")}>Country{sortIndicator("country")}</th>
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("theatre")}>Theatre{sortIndicator("theatre")}</th>
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("topTier")}>Best move{sortIndicator("topTier")}</th>
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("specialisation")}>Specialisation{sortIndicator("specialisation")}</th>
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("training")} title="ILT/OLX (or legacy cert) they already hold that gives them a head-start">Relevant training held{sortIndicator("training")}</th>
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("closesCount")}>{countLabel}{sortIndicator("closesCount")}</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <Fragment key={c.email}>
                  <tr className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer" onClick={() => toggle(c.email)}>
                    <td className="py-2 pr-3 font-medium">
                      <Link href={`/students/${encodeURIComponent(c.email)}`} className="text-blue-600 hover:underline" onClick={(e) => e.stopPropagation()}>{c.fullName}</Link>
                    </td>
                    <td className="py-2 pr-3">{c.country}</td>
                    <td className="py-2 pr-3">{c.theatre}</td>
                    <td className="py-2 pr-3"><span className={`px-1.5 py-0.5 rounded-full text-xs ${TIER_BADGE[c.topTier]}`}>{TIER_LABEL[c.topTier]}</span></td>
                    <td className="py-2 pr-3">{candidateSpecialisations(c) || <span className="text-gray-400">—</span>}</td>
                    <td className="py-2 pr-3">{candidateHelpfulTraining(c) || <span className="text-gray-400">—</span>}</td>
                    <td className="py-2 pr-3">{c.closesCount}</td>
                    <td className="py-2">{expanded.has(c.email) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                  </tr>
                  {expanded.has(c.email) && (
                    <tr className="bg-gray-50/60">
                      <td colSpan={8} className="py-2 px-4">
                        <ul className="space-y-2 text-xs text-gray-700">
                          {c.closes.map((cl, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className={`shrink-0 px-1.5 py-0.5 rounded-full ${TIER_BADGE[cl.tier]}`}>{TIER_LABEL[cl.tier]}</span>
                              <CloseSentence cl={cl} />
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Renewal-at-risk overlay ──
function RenewalTable({
  renewals,
  impacts,
  windowMonths,
  planForWindow,
  scopeLabel,
}: {
  renewals: PlanRenewalRow[];
  impacts: PlanRiskImpact[];
  windowMonths: number;
  planForWindow: boolean;
  scopeLabel: string;
}) {
  const [showExport, setShowExport] = useState(false);
  const exportSection = buildRenewalSection(renewals, windowMonths);
  return (
    <div className="bg-white rounded-lg border border-amber-200 p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="flex items-center gap-2 text-base font-semibold text-amber-800">
          <AlertTriangle size={18} /> Renewals at risk — expiring within {windowMonths} month{windowMonths === 1 ? "" : "s"} ({renewals.length})
        </h2>
        <ExportMenu show={showExport} setShow={setShowExport} data={exportSection.rows} columns={exportSection.columns} filename={`compliance-plan-renewals-${scopeLabel}`} align="right" />
      </div>
      {impacts.length > 0 && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2">
          <div className="text-xs font-medium text-amber-800 mb-1">
            If these aren&apos;t renewed, {impacts.length} requirement{impacts.length === 1 ? "" : "s"}{" "}
            fall{impacts.length === 1 ? "s" : ""} below target:
          </div>
          <ul className="text-xs text-amber-900 space-y-0.5">
            {impacts.map((i, n) => (
              <li key={n}>
                <span className="font-medium">{i.program}</span>
                {(i.specialisation || i.tierName) && <span className="text-amber-700/80"> · {i.specialisation ?? i.tierName}</span>}
                {" — "}
                {i.cert}:{" "}
                <span className="font-medium">
                  {i.attained} → {i.projectedAttained}
                </span>{" "}
                / {i.required} ({i.scopeLabel})
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-gray-500 mb-2">
        {planForWindow
          ? "These holders' training expires within the window. The renewals needed to hold compliance are already counted in “People to certify” above — don't add the two figures together."
          : "These holders currently count toward a gap the plan reports as closed — their expiry will re-open it."}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
              <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Country</th><th className="py-2 pr-3">Theatre</th><th className="py-2 pr-3">Cert</th><th className="py-2">Scope</th>
            </tr>
          </thead>
          <tbody>
            {renewals.map((r, i) => (
              <tr key={`${r.email}-${i}`} className="border-b border-gray-50">
                <td className="py-1.5 pr-3"><Link href={`/students/${encodeURIComponent(r.email)}`} className="text-blue-600 hover:underline">{r.fullName}</Link></td>
                <td className="py-1.5 pr-3">{r.country}</td>
                <td className="py-1.5 pr-3">{r.theatre}</td>
                <td className="py-1.5 pr-3">{r.cert}</td>
                <td className="py-1.5">{r.scopeLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
