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
  ExternalLink,
} from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { ExportMenu } from "@/components/programs/ProgramCompliance";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";
import { useRegionData } from "@/hooks/useRegionData";
import { useTableSort } from "@/hooks/useTableSort";
import { useDebounce } from "@/hooks/useDebounce";
import { useFetchJson } from "@/hooks/useFetchJson";

// ── API shapes (mirror lib/compliance-plan.ts) ──
type CandidateTier = "easy-win" | "lapsed" | "legacy" | "net-new";

interface PlanRequirement {
  instanceId: string;
  specialisation: string | null;
  tierName: string | null;
  nativeLevel: string;
  scopeLabel: string;
  cert: string;
  required: number;
  attained: number;
  shortfall: number;
  easyWinPool: number;
  lapsedPool: number;
  legacyPool: number;
  netNew: number;
  expiringSoon: number;
}
interface PlanSpecialisation {
  name: string;
  achieved: boolean;
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
  targets: PlanTargetResult[];
  candidates: PlanCandidate[];
  renewals: PlanRenewalRow[];
  totals: { peopleMoves: number; easyWins: number; lapsed: number; legacy: number; netNew: number; renewalsAtRisk: number };
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
  "easy-win": "Easy win",
  lapsed: "Lapsed (renew)",
  legacy: "Legacy upgrade",
  "net-new": "Net-new",
};
const TIER_BADGE: Record<CandidateTier, string> = {
  "easy-win": "bg-green-100 text-green-800",
  lapsed: "bg-amber-100 text-amber-800",
  legacy: "bg-indigo-100 text-indigo-800",
  "net-new": "bg-gray-100 text-gray-700",
};

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
    return `/api/programs/planning?${params.toString()}`;
  }, [active, debouncedPayload, level, scopeValue, companyId, renewalWindowMonths]);

  const { data: plan, loading } = useFetchJson<CompliancePlanResult>(planUrl, { enabled: active });

  const kpis = plan
    ? [
        { label: "People to certify", value: plan.totals.peopleMoves, icon: Users, tone: "blue" as const },
        { label: "Easy wins", value: plan.totals.easyWins, icon: Zap, tone: "green" as const, hint: "Just need the exam" },
        { label: "Net-new training", value: plan.totals.netNew, icon: ClipboardCheck, tone: "indigo" as const },
        { label: "Renewals at risk", value: plan.totals.renewalsAtRisk, icon: RefreshCw, tone: "amber" as const, hint: `Expire within ${renewalWindowMonths}mo` },
      ]
    : [];

  return (
    <div>
      <PageHeader
        title="Compliance Planning"
        helpSlug="compliance-planning"
        showBack
        rightContent={
          <label className="flex items-center gap-2 text-sm text-gray-600">
            Renewal window
            <select
              value={renewalWindowMonths}
              onChange={(e) => setRenewalWindowMonths(parseInt(e.target.value, 10))}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
            >
              <option value={0}>Off</option>
              <option value={1}>1 month</option>
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
            </select>
          </label>
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
          <KpiStrip cards={kpis} />

          {/* Aggregate roadmap */}
          <div className="space-y-4 mb-6">
            {plan.targets.map((t) => <TargetCard key={t.program} target={t} />)}
          </div>

          {/* Candidate-centric drill-down */}
          <CandidateTable candidates={plan.candidates} scopeLabel={plan.scopeLabel} />

          {/* Renewal-at-risk */}
          {plan.renewals.length > 0 && <RenewalTable renewals={plan.renewals} windowMonths={renewalWindowMonths} scopeLabel={plan.scopeLabel} />}
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
function TargetCard({ target }: { target: PlanTargetResult }) {
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
        {target.specialisations.map((s) => <SpecBlock key={s.name} spec={s} tiered={!!target.tierPlan} />)}
      </div>
    </div>
  );
}

function SpecBlock({ spec, tiered }: { spec: PlanSpecialisation; tiered: boolean }) {
  const [open, setOpen] = useState(!spec.achieved);
  const dim = tiered && spec.chosen === false && !spec.achieved;
  return (
    <div className={`rounded-lg border ${spec.achieved ? "border-green-200 bg-green-50/50" : "border-gray-200"} ${dim ? "opacity-60" : ""}`}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="flex items-center gap-2 text-sm font-medium">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {spec.name}
          {spec.achieved && <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-800">Achieved</span>}
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
                {spec.requirements.map((r) => <ReqRow key={r.instanceId} r={r} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ReqRow({ r }: { r: PlanRequirement }) {
  const met = r.shortfall === 0;
  return (
    <tr className={`border-b border-gray-50 ${met ? "" : "bg-red-50/40"}`}>
      <td className="py-1.5 pr-3">{r.cert}</td>
      <td className="py-1.5 pr-3">
        {r.scopeLabel}
        {r.expiringSoon > 0 && <span className="ml-1 text-xs text-amber-600" title="Active holders expiring within the renewal window">▼{r.expiringSoon}</span>}
      </td>
      <td className={`py-1.5 pr-3 ${met ? "text-green-700" : "text-red-700"}`}>{r.attained} / {r.required}</td>
      <td className="py-1.5 pr-3">{met ? <span className="text-green-600">✓</span> : <span className="font-medium text-red-700">need {r.shortfall}</span>}</td>
      <td className="py-1.5 text-xs text-gray-600">
        {met ? "—" : (
          <span className="flex flex-wrap gap-1">
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

// ── Candidate-centric drill-down ──
function CandidateTable({ candidates, scopeLabel }: { candidates: PlanCandidate[]; scopeLabel: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showExport, setShowExport] = useState(false);

  const { sorted, toggleSort, sortIndicator } = useTableSort(candidates, {
    fullName: (c) => c.fullName,
    country: (c) => c.country,
    theatre: (c) => c.theatre,
    topTier: (c) => c.topTier,
    closesCount: (c) => c.closesCount,
  }, { defaultKey: "topTier", tiebreakKey: "fullName", descFirstKeys: ["closesCount"] });

  const exportData = candidates.map((c) => ({
    Name: c.fullName,
    Email: c.email,
    Country: c.country,
    Theatre: c.theatre,
    Tier: TIER_LABEL[c.topTier],
    "Gaps closed": c.closesCount,
    Detail: c.closes.map((cl) => `${cl.cert} (${cl.scopeLabel})${cl.path ? ` via ${cl.path}` : ""} [${TIER_LABEL[cl.tier]}]`).join("; "),
  }));
  const exportCols = [
    { key: "Name", header: "Name" }, { key: "Email", header: "Email" },
    { key: "Country", header: "Country" }, { key: "Theatre", header: "Theatre" },
    { key: "Tier", header: "Tier" }, { key: "Gaps closed", header: "Gaps closed" }, { key: "Detail", header: "Detail" },
  ];

  const toggle = (email: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(email)) next.delete(email); else next.add(email);
    return next;
  });

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Who to certify ({candidates.length})</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            These people are the cheapest to certify — most have already done the required training and just need to sit the exam.
          </p>
        </div>
        {candidates.length > 0 && (
          <ExportMenu show={showExport} setShow={setShowExport} data={exportData} columns={exportCols} filename={`compliance-plan-candidates-${scopeLabel}`} align="right" />
        )}
      </div>
      {candidates.length === 0 ? (
        <p className="text-sm text-gray-500">No named candidates — remaining gaps need brand-new training (net-new), or everything is already met.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("fullName")}>Name{sortIndicator("fullName")}</th>
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("country")}>Country{sortIndicator("country")}</th>
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("theatre")}>Theatre{sortIndicator("theatre")}</th>
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("topTier")}>Best move{sortIndicator("topTier")}</th>
                <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleSort("closesCount")}>Gaps closed{sortIndicator("closesCount")}</th>
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
                    <td className="py-2 pr-3">{c.closesCount}</td>
                    <td className="py-2">{expanded.has(c.email) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                  </tr>
                  {expanded.has(c.email) && (
                    <tr className="bg-gray-50/60">
                      <td colSpan={6} className="py-2 px-4">
                        <ul className="space-y-1 text-xs text-gray-700">
                          {c.closes.map((cl, i) => (
                            <li key={i} className="flex items-center gap-2">
                              <span className={`px-1.5 py-0.5 rounded-full ${TIER_BADGE[cl.tier]}`}>{TIER_LABEL[cl.tier]}</span>
                              <span className="font-medium">{cl.cert}</span>
                              <span className="text-gray-400">·</span>
                              <span>{cl.program}{cl.specialisation ? ` › ${cl.specialisation}` : ""}{cl.tierName ? ` › ${cl.tierName}` : ""} ({cl.scopeLabel})</span>
                              {cl.path && <span className="text-gray-400 flex items-center gap-0.5"><ExternalLink size={11} /> via {cl.path}</span>}
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
function RenewalTable({ renewals, windowMonths, scopeLabel }: { renewals: PlanRenewalRow[]; windowMonths: number; scopeLabel: string }) {
  const [showExport, setShowExport] = useState(false);
  const exportData = renewals.map((r) => ({ Name: r.fullName, Email: r.email, Country: r.country, Theatre: r.theatre, Cert: r.cert, Scope: r.scopeLabel }));
  const exportCols = [
    { key: "Name", header: "Name" }, { key: "Email", header: "Email" }, { key: "Country", header: "Country" },
    { key: "Theatre", header: "Theatre" }, { key: "Cert", header: "Cert" }, { key: "Scope", header: "Scope" },
  ];
  return (
    <div className="bg-white rounded-lg border border-amber-200 p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="flex items-center gap-2 text-base font-semibold text-amber-800">
          <AlertTriangle size={18} /> Renewals at risk — expiring within {windowMonths} month{windowMonths === 1 ? "" : "s"} ({renewals.length})
        </h2>
        <ExportMenu show={showExport} setShow={setShowExport} data={exportData} columns={exportCols} filename={`compliance-plan-renewals-${scopeLabel}`} align="right" />
      </div>
      <p className="text-xs text-gray-500 mb-2">These holders currently count toward a gap the plan reports as closed — their expiry will re-open it.</p>
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
