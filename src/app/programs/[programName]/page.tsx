"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import {
  Globe,
  Building2,
  MapPin,
  Map,
  Layers,
  ExternalLink,
} from "lucide-react";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";
import {
  ComplianceTable,
  SpecialisationCard,
  ExportMenu,
  LoadingSpinner,
  TierLadder,
  TRAINING_TYPE_LABELS,
  type AlternativeEntry,
  type Specialisation,
  type StudentEntry,
  type TierBlock,
} from "@/components/programs/ProgramCompliance";

interface ProgramMeta {
  levels: string[];
  hasMinimumPerTheatre: boolean;
  isTiered?: boolean;
  deploymentMode?: string;
}

type ScopeLevel = "global" | "theatre" | "region" | "country";

export default function ProgramDetailPage() {
  const params = useParams<{ programName: string }>();
  const programName = useMemo(() => {
    try {
      return decodeURIComponent(params.programName);
    } catch {
      return params.programName;
    }
  }, [params.programName]);
  const apiBase = `/api/programs/${encodeURIComponent(programName)}`;

  const companyScope = useCompanyScope();
  // Compliance is per-company; force a single-company selection.
  const [companyId, setCompanyId] = useState<number | null>(null);
  useEffect(() => {
    if (companyScope.loading) return;
    if (companyScope.selected !== "all") {
      setCompanyId(companyScope.selected);
    } else if (companyScope.companies.length > 0) {
      setCompanyId((prev) => prev ?? companyScope.companies[0].id);
    }
  }, [companyScope.loading, companyScope.selected, companyScope.companies]);
  const companyQS = companyId !== null ? `&companyId=${companyId}` : "";

  // Forward-looking projection horizon (0 = today). When > 0 the dashboard shows
  // how compliance will stand once certs expiring within the window drop out.
  const [horizonMonths, setHorizonMonths] = useState(0);
  const horizonQS = horizonMonths > 0 ? `&horizonMonths=${horizonMonths}` : "";

  const [meta, setMeta] = useState<ProgramMeta | null>(null);
  const [countries, setCountries] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [theatres, setTheatres] = useState<string[]>([]);

  // Single page-level scope: a level plus (for non-global levels) a value. This
  // one selection drives BOTH the Tier Status block and the matching report,
  // which the API returns together in a single response per level.
  const [scopeLevel, setScopeLevel] = useState<ScopeLevel>("global");
  const [scopeValue, setScopeValue] = useState("");
  const [scopeInitialised, setScopeInitialised] = useState(false);

  const [specs, setSpecs] = useState<Specialisation[]>([]);
  const [tierBlock, setTierBlock] = useState<TierBlock | null>(null);
  const [loading, setLoading] = useState(false);

  // Student modal
  const [showStudents, setShowStudents] = useState(false);
  const [studentList, setStudentList] = useState<StudentEntry[]>([]);
  const [studentLoading, setStudentLoading] = useState(false);
  const [studentTitle, setStudentTitle] = useState("");

  // Export menu (single — one report is shown at a time)
  const [showExport, setShowExport] = useState(false);

  const hasCountry = meta?.levels.includes("Country") ?? false;
  const hasTheatre = meta?.levels.includes("Theatre") ?? false;
  const hasGlobal = meta?.levels.includes("Global") ?? false;
  const gdStyleGlobal = meta?.hasMinimumPerTheatre ?? false;
  const isTiered = meta?.isTiered ?? false;

  const needsValue = scopeLevel !== "global";
  const scopeValues = scopeLevel === "theatre" ? theatres : scopeLevel === "region" ? regions : countries;
  const scopeMissing = needsValue && !scopeValue;

  // Initial load — fetch metadata + available countries/regions/theatres.
  useEffect(() => {
    if (companyId === null) return;
    fetch(`${apiBase}?level=country${companyQS}`)
      .then((r) => r.json())
      .then((data) => {
        setCountries(data.countries || []);
        setRegions(data.regions || []);
        setTheatres(data.theatres || []);
        setMeta(data.meta || { levels: [], hasMinimumPerTheatre: false });
      })
      .catch(() => {});
  }, [companyId, companyQS, apiBase]);

  // Default the scope once we know which levels exist: pick the broadest
  // configured level, and auto-select the first value for value-requiring levels.
  useEffect(() => {
    if (!meta || scopeInitialised || meta.levels.length === 0) return;
    if (meta.levels.includes("Global")) {
      setScopeLevel("global");
      setScopeValue("");
    } else if (meta.levels.includes("Theatre")) {
      setScopeLevel("theatre");
      setScopeValue(theatres[0] ?? "");
    } else if (meta.levels.includes("Country")) {
      setScopeLevel("country");
      setScopeValue(countries[0] ?? "");
    }
    setScopeInitialised(true);
  }, [meta, scopeInitialised, theatres, countries]);

  const changeScopeLevel = (level: ScopeLevel) => {
    setScopeLevel(level);
    if (level === "global") setScopeValue("");
    else if (level === "theatre") setScopeValue(theatres[0] ?? "");
    else if (level === "region") setScopeValue(regions[0] ?? "");
    else setScopeValue(countries[0] ?? "");
  };

  // Single scoped fetch — returns both the specialisations report and the tier
  // block for the selected scope.
  useEffect(() => {
    if (companyId === null || !scopeInitialised) return;
    if (needsValue && !scopeValue) {
      setSpecs([]);
      setTierBlock(null);
      return;
    }
    setLoading(true);
    const qs = new URLSearchParams({ level: scopeLevel });
    if (scopeLevel === "country") qs.set("country", scopeValue);
    else if (scopeLevel === "region") qs.set("region", scopeValue);
    else if (scopeLevel === "theatre") qs.set("theatre", scopeValue);
    fetch(`${apiBase}?${qs.toString()}${companyQS}${horizonQS}`)
      .then((r) => r.json())
      .then((data) => {
        setSpecs(data.specialisations || []);
        setTierBlock(data.tiers ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [scopeLevel, scopeValue, needsValue, scopeInitialised, companyId, companyQS, horizonQS, apiBase]);

  const viewStudents = async (
    trainingTitle: string,
    trainingFullTitle: string,
    level: string,
    filterValue: string,
    alternatives?: AlternativeEntry[]
  ) => {
    setStudentTitle(trainingFullTitle);
    setStudentLoading(true);
    setShowStudents(true);
    setStudentList([]);

    const allTitles = [trainingTitle, ...(alternatives || []).map((a) => a.trainingTitle)].filter(Boolean);
    const params = new URLSearchParams({
      students: "true",
      trainingTitle: allTitles.join(","),
      level,
    });
    if (level === "country") params.set("country", filterValue);
    if (level === "region") params.set("region", filterValue);
    if (level === "theatre") params.set("theatre", filterValue);
    if (companyId !== null) params.set("companyId", String(companyId));

    try {
      const res = await fetch(`${apiBase}?${params}`);
      const data = await res.json();
      setStudentList(data.students || []);
    } catch {
      setStudentList([]);
    } finally {
      setStudentLoading(false);
    }
  };

  // APS-style flat export (Country / Region / Theatre / theatre-count Global).
  const buildExportData = (specList: Specialisation[], levelLabel: string, filterValue: string) => {
    const rows: Record<string, string | number>[] = [];
    for (const spec of specList) {
      const emit = (req: Specialisation["requirements"][number], purpose: string) => {
        let trainingLabel = req.trainingFullTitle;
        if (req.alternatives && req.alternatives.length > 0) {
          trainingLabel += " (or " + req.alternatives.map((a) => a.trainingFullTitle).join(", ") + ")";
        }
        const row: Record<string, string | number> = {
          specialisation: spec.name,
          purpose,
          training: trainingLabel,
          type: req.trainingType ? TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType : "—",
          required: req.quantityRequired,
          attained: req.attained,
          compliant: req.attained >= req.quantityRequired ? "Yes" : "No",
        };
        if (horizonMonths > 0) {
          const projected = req.projectedAttained ?? req.attained;
          row.projectedAttained = projected;
          row.expiring = Math.max(0, req.attained - projected);
          row.projectedCompliant = projected >= req.quantityRequired ? "Yes" : "No";
        }
        row.level = levelLabel;
        row.filter = filterValue;
        rows.push(row);
      };
      spec.requirements.forEach((req) => emit(req, "Qualification"));
      (spec.deploymentRequirements ?? []).forEach((req) => emit(req, "Deployment"));
    }
    return rows;
  };

  const exportCols = [
    { key: "specialisation", header: "Specialisation" },
    { key: "purpose", header: "Purpose" },
    { key: "training", header: "Training" },
    { key: "type", header: "Type" },
    { key: "required", header: "Required" },
    { key: "attained", header: "Attained" },
    { key: "compliant", header: "Compliant" },
    ...(horizonMonths > 0
      ? [
          { key: "projectedAttained", header: `Projected (+${horizonMonths}mo)` },
          { key: "expiring", header: "Expiring" },
          { key: "projectedCompliant", header: "Projected Compliant" },
        ]
      : []),
    { key: "level", header: "Level" },
    { key: "filter", header: "Filter" },
  ];

  // Global Diamond-style export (global counts + per-theatre breakdown rows).
  const buildGlobalDiamondExport = () => {
    const rows: Record<string, string | number>[] = [];
    for (const spec of specs) {
      const emit = (req: Specialisation["requirements"][number], purpose: string) => {
        let trainingLabel = req.trainingFullTitle;
        if (req.alternatives && req.alternatives.length > 0) {
          trainingLabel += " (or " + req.alternatives.map((a) => a.trainingFullTitle).join(", ") + ")";
        }
        const globalAttained = req.globalAttained ?? req.attained;
        const projectedGlobal = req.projectedGlobalAttained ?? globalAttained;
        const projCols = (count: number, projected: number, required: number): Record<string, string | number> =>
          horizonMonths > 0
            ? {
                projectedCount: projected,
                expiring: Math.max(0, count - projected),
                projectedCompliant: projected >= required ? "Yes" : "No",
              }
            : {};
        rows.push({
          specialisation: spec.name,
          purpose,
          training: trainingLabel,
          type: req.trainingType ? TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType : "—",
          required: req.quantityRequired,
          attained: globalAttained,
          compliant: req.compliant ? "Yes" : "No",
          theatre: "Global",
          theatreCount: globalAttained,
          theatreRequired: req.quantityRequired,
          theatreCompliant: req.compliant ? "Yes" : "No",
          ...projCols(globalAttained, projectedGlobal, req.quantityRequired),
        });
        if (req.theatreBreakdown) {
          for (const t of req.theatreBreakdown) {
            const tReq = req.minimumPerTheatre ?? 0;
            const tProjected = req.projectedTheatreBreakdown?.find((p) => p.theatre === t.theatre)?.count ?? t.count;
            rows.push({
              specialisation: spec.name,
              purpose,
              training: req.trainingFullTitle,
              type: req.trainingType ? TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType : "—",
              required: req.quantityRequired,
              attained: globalAttained,
              compliant: req.compliant ? "Yes" : "No",
              theatre: t.theatre,
              theatreCount: t.count,
              theatreRequired: tReq,
              theatreCompliant: t.compliant ? "Yes" : "No",
              ...projCols(t.count, tProjected, tReq),
            });
          }
        }
      };
      spec.requirements.forEach((req) => emit(req, "Qualification"));
      (spec.deploymentRequirements ?? []).forEach((req) => emit(req, "Deployment"));
    }
    return rows;
  };

  const gdExportCols = [
    { key: "specialisation", header: "Specialisation" },
    { key: "purpose", header: "Purpose" },
    { key: "training", header: "Training" },
    { key: "type", header: "Type" },
    { key: "required", header: "Global Required" },
    { key: "attained", header: "Global Attained" },
    { key: "compliant", header: "Compliant" },
    { key: "theatre", header: "Theatre" },
    { key: "theatreCount", header: "Theatre Count" },
    { key: "theatreRequired", header: "Theatre Required" },
    { key: "theatreCompliant", header: "Theatre Compliant" },
    ...(horizonMonths > 0
      ? [
          { key: "projectedCount", header: `Projected (+${horizonMonths}mo)` },
          { key: "expiring", header: "Expiring" },
          { key: "projectedCompliant", header: "Projected Compliant" },
        ]
      : []),
  ];

  const sectionSlug = programName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const horizonSuffix = horizonMonths > 0 ? `-plus${horizonMonths}mo` : "";

  // Report presentation for the selected scope.
  const REPORT_META: Record<ScopeLevel, { label: string; icon: ReactNode; unit: "people" | "theatres" }> = {
    country: { label: "Country Report", icon: <MapPin size={20} className="text-blue-600" />, unit: "people" },
    region: { label: "Region Report", icon: <Map size={20} className="text-teal-600" />, unit: "people" },
    theatre: { label: "Theatre Report", icon: <Building2 size={20} className="text-purple-600" />, unit: "people" },
    global: { label: "Global Report", icon: <Globe size={20} className="text-green-600" />, unit: "theatres" },
  };
  const report = REPORT_META[scopeLevel];
  const reportTitle = needsValue && scopeValue ? `${report.label} — ${scopeValue}` : report.label;

  const exportData = gdStyleGlobal && scopeLevel === "global"
    ? buildGlobalDiamondExport()
    : buildExportData(specs, report.label.replace(" Report", ""), needsValue ? scopeValue : "Global");
  const exportColumns = gdStyleGlobal && scopeLevel === "global" ? gdExportCols : exportCols;
  const exportFilename = `${sectionSlug}-${scopeLevel}${needsValue && scopeValue ? `-${scopeValue}` : ""}${horizonSuffix}`;

  const noLevels = meta !== null && meta.levels.length === 0;

  return (
    <div>
      <PageHeader
        title={programName}
        helpSlug="programs-detail"
        showBack
        rightContent={
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-500">Company</label>
            <select
              value={companyId ?? ""}
              onChange={(e) => setCompanyId(e.target.value ? Number(e.target.value) : null)}
              className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white"
            >
              {companyScope.companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <label className="text-sm text-gray-500 ml-2">Compliance as of</label>
            <select
              value={horizonMonths}
              onChange={(e) => setHorizonMonths(Number(e.target.value))}
              className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white"
              title="Project compliance forward to see the impact of upcoming certificate expiry"
            >
              <option value={0}>Now</option>
              <option value={3}>+3 months</option>
              <option value={6}>+6 months</option>
              <option value={12}>+12 months</option>
            </select>
          </div>
        }
      />

      {horizonMonths > 0 && meta && meta.levels.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <span className="font-medium">Projection:</span>
          <span>
            Showing compliance as it will stand in <strong>{horizonMonths} months</strong> (current → projected).
            Items shaded <span className="font-medium text-amber-700">amber</span> are compliant today but will
            fall below their requirement as certificates expire within the window.
          </span>
        </div>
      )}

      {noLevels && (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          No compliance data configured for <strong>{programName}</strong>. Add requirements in{" "}
          <Link href="/admin/program-data" className="text-blue-600 hover:underline">Admin &rsaquo; Program Data</Link>{" "}
          using this program name.
        </div>
      )}

      {meta && meta.levels.length > 0 && (
        <>
          {/* Page-level scope selector — drives both the tier status and report. */}
          <div className="mb-6 flex flex-wrap items-center gap-3 bg-white rounded-lg border border-gray-200 p-4">
            <label className="text-sm font-medium text-gray-700">View</label>
            <select
              value={scopeLevel}
              onChange={(e) => changeScopeLevel(e.target.value as ScopeLevel)}
              className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            >
              {hasGlobal && <option value="global">Global</option>}
              {hasTheatre && <option value="theatre">By Theatre</option>}
              {hasCountry && <option value="region">By Region</option>}
              {hasCountry && <option value="country">By Country</option>}
            </select>
            {needsValue && (
              <select
                value={scopeValue}
                onChange={(e) => setScopeValue(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm min-w-[200px]"
              >
                <option value="">Select a {scopeLevel}...</option>
                {scopeValues.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            )}
          </div>

          {/* Tier Status (tiered programs) */}
          {isTiered && (
            <section className="mb-6">
              <div className="flex items-center gap-2 p-4 bg-white rounded-lg border border-gray-200">
                <Layers size={20} className="text-indigo-600" />
                <span className="text-lg font-semibold">Tier Status</span>
              </div>
              <div className="mt-2 bg-white rounded-lg border border-gray-200 p-4">
                {loading ? (
                  <LoadingSpinner />
                ) : scopeMissing ? (
                  <p className="text-sm text-gray-500">Select a {scopeLevel} to view tier status.</p>
                ) : !tierBlock ? (
                  <p className="text-sm text-gray-500">No tier data for this program.</p>
                ) : (
                  <TierLadder block={tierBlock} />
                )}
              </div>
            </section>
          )}

          {/* Compliance report for the selected scope */}
          <section className="mb-6">
            <div className="flex items-center justify-between gap-3 p-4 bg-white rounded-lg border border-gray-200">
              <div className="flex items-center gap-2">
                {report.icon}
                <span className="text-lg font-semibold">{reportTitle}</span>
              </div>
              {!scopeMissing && specs.length > 0 && (
                <ExportMenu
                  show={showExport}
                  setShow={setShowExport}
                  data={exportData}
                  columns={exportColumns}
                  filename={exportFilename}
                  align="right"
                />
              )}
            </div>
            <div className="mt-2">
              {loading ? (
                <div className="bg-white rounded-lg border border-gray-200 p-4"><LoadingSpinner /></div>
              ) : scopeMissing ? (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <p className="text-sm text-gray-500">Select a {scopeLevel} to view compliance data.</p>
                </div>
              ) : specs.length === 0 ? (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <p className="text-sm text-gray-500">No {scopeLevel}-level requirements found for this program.</p>
                </div>
              ) : scopeLevel === "global" && gdStyleGlobal ? (
                specs.map((spec) => <SpecialisationCard key={spec.name} spec={spec} />)
              ) : (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <ComplianceTable
                    specialisations={specs}
                    level={scopeLevel}
                    filterValue={needsValue ? scopeValue : ""}
                    onViewStudents={viewStudents}
                    unitLabel={report.unit}
                  />
                </div>
              )}
            </div>
          </section>
        </>
      )}

      {/* Student Modal */}
      <Modal open={showStudents} onClose={() => setShowStudents(false)} title={`Students — ${studentTitle}`} size="4xl">
        {studentLoading ? (
          <LoadingSpinner />
        ) : studentList.length === 0 ? (
          <p className="text-sm text-gray-500">No students found.</p>
        ) : (
          <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Full Name</th>
                  <th className="px-3 py-2 text-left font-medium">Email</th>
                  <th className="px-3 py-2 text-left font-medium">Country</th>
                  <th className="px-3 py-2 text-left font-medium">Theatre</th>
                  <th className="px-3 py-2 text-left font-medium">Completed</th>
                  <th className="px-3 py-2 text-left font-medium">Expires</th>
                  <th className="px-3 py-2 text-center font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {studentList.map((s) => (
                  <tr key={s.email} className="border-t border-gray-100">
                    <td className="px-3 py-2">{s.fullName}</td>
                    <td className="px-3 py-2">{s.email}</td>
                    <td className="px-3 py-2">{s.country}</td>
                    <td className="px-3 py-2">{s.theatre}</td>
                    <td className="px-3 py-2">{s.completedDate}</td>
                    <td className="px-3 py-2">{s.expiryDate}</td>
                    <td className="px-3 py-2 text-center">
                      <a
                        href={`/students/${encodeURIComponent(s.email)}`}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                      >
                        <ExternalLink size={12} /> View
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
