"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import {
  ChevronDown,
  ChevronRight,
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

  // Section data
  const [countryOpen, setCountryOpen] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState("");
  const [countrySpecs, setCountrySpecs] = useState<Specialisation[]>([]);
  const [countryLoading, setCountryLoading] = useState(false);

  const [regionOpen, setRegionOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState("");
  const [regionSpecs, setRegionSpecs] = useState<Specialisation[]>([]);
  const [regionLoading, setRegionLoading] = useState(false);

  const [theatreOpen, setTheatreOpen] = useState(false);
  const [selectedTheatre, setSelectedTheatre] = useState("");
  const [theatreSpecs, setTheatreSpecs] = useState<Specialisation[]>([]);
  const [theatreLoading, setTheatreLoading] = useState(false);

  const [globalOpen, setGlobalOpen] = useState(false);
  const [globalSpecs, setGlobalSpecs] = useState<Specialisation[]>([]);
  const [globalLoading, setGlobalLoading] = useState(false);

  // Tier ladder (tiered programs only)
  const [tierOpen, setTierOpen] = useState(true);
  const [tierLevel, setTierLevel] = useState("");
  const [tierScopeValue, setTierScopeValue] = useState("");
  const [tierBlock, setTierBlock] = useState<TierBlock | null>(null);
  const [tierLoading, setTierLoading] = useState(false);

  // Student modal
  const [showStudents, setShowStudents] = useState(false);
  const [studentList, setStudentList] = useState<StudentEntry[]>([]);
  const [studentLoading, setStudentLoading] = useState(false);
  const [studentTitle, setStudentTitle] = useState("");

  // Export menus
  const [showExportCountry, setShowExportCountry] = useState(false);
  const [showExportRegion, setShowExportRegion] = useState(false);
  const [showExportTheatre, setShowExportTheatre] = useState(false);
  const [showExportGlobal, setShowExportGlobal] = useState(false);

  const hasCountry = meta?.levels.includes("Country") ?? false;
  const hasTheatre = meta?.levels.includes("Theatre") ?? false;
  const hasGlobal = meta?.levels.includes("Global") ?? false;
  const gdStyleGlobal = meta?.hasMinimumPerTheatre ?? false;
  const isTiered = meta?.isTiered ?? false;
  const tierNeedsScope = (tierLevel === "country" || tierLevel === "theatre") && !tierScopeValue;
  // When the program only has a Global Report (no Country/Region/Theatre
  // sections), the Global export lives in the page header — between the
  // company dropdown and the help button — rather than under the heading.
  const globalOnly = hasGlobal && !hasCountry && !hasTheatre;

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

  // Default the open section sensibly once we know which levels exist.
  useEffect(() => {
    if (!meta) return;
    const levels = meta.levels;
    if (levels.includes("Country")) setCountryOpen(true);
    else if (levels.includes("Theatre")) setTheatreOpen(true);
    else if (levels.includes("Global")) setGlobalOpen(true);
  }, [meta]);

  // Country report
  useEffect(() => {
    if (!selectedCountry || companyId === null) {
      setCountrySpecs([]);
      return;
    }
    setCountryLoading(true);
    fetch(`${apiBase}?level=country&country=${encodeURIComponent(selectedCountry)}${companyQS}${horizonQS}`)
      .then((r) => r.json())
      .then((data) => setCountrySpecs(data.specialisations || []))
      .catch(() => {})
      .finally(() => setCountryLoading(false));
  }, [selectedCountry, companyId, companyQS, horizonQS, apiBase]);

  // Region report
  useEffect(() => {
    if (!selectedRegion || companyId === null) {
      setRegionSpecs([]);
      return;
    }
    setRegionLoading(true);
    fetch(`${apiBase}?level=region&region=${encodeURIComponent(selectedRegion)}${companyQS}${horizonQS}`)
      .then((r) => r.json())
      .then((data) => setRegionSpecs(data.specialisations || []))
      .catch(() => {})
      .finally(() => setRegionLoading(false));
  }, [selectedRegion, companyId, companyQS, horizonQS, apiBase]);

  // Theatre report
  useEffect(() => {
    if (!selectedTheatre || companyId === null) {
      setTheatreSpecs([]);
      return;
    }
    setTheatreLoading(true);
    fetch(`${apiBase}?level=theatre&theatre=${encodeURIComponent(selectedTheatre)}${companyQS}${horizonQS}`)
      .then((r) => r.json())
      .then((data) => setTheatreSpecs(data.specialisations || []))
      .catch(() => {})
      .finally(() => setTheatreLoading(false));
  }, [selectedTheatre, companyId, companyQS, horizonQS, apiBase]);

  // Global report
  useEffect(() => {
    if (!globalOpen || companyId === null) return;
    setGlobalLoading(true);
    fetch(`${apiBase}?level=global${companyQS}${horizonQS}`)
      .then((r) => r.json())
      .then((data) => setGlobalSpecs(data.specialisations || []))
      .catch(() => {})
      .finally(() => setGlobalLoading(false));
  }, [globalOpen, companyId, companyQS, horizonQS, apiBase]);

  // Default the tier level to the broadest configured level once meta loads.
  useEffect(() => {
    if (!meta?.isTiered || tierLevel) return;
    if (meta.levels.includes("Global")) setTierLevel("global");
    else if (meta.levels.includes("Theatre")) setTierLevel("theatre");
    else if (meta.levels.includes("Country")) setTierLevel("country");
  }, [meta, tierLevel]);

  // Tier ladder
  useEffect(() => {
    if (!isTiered || companyId === null || !tierOpen || !tierLevel) return;
    if ((tierLevel === "country" || tierLevel === "theatre") && !tierScopeValue) {
      setTierBlock(null);
      return;
    }
    setTierLoading(true);
    const params = new URLSearchParams({ level: tierLevel });
    if (tierLevel === "country") params.set("country", tierScopeValue);
    if (tierLevel === "theatre") params.set("theatre", tierScopeValue);
    fetch(`${apiBase}?${params.toString()}${companyQS}${horizonQS}`)
      .then((r) => r.json())
      .then((data) => setTierBlock(data.tiers ?? null))
      .catch(() => {})
      .finally(() => setTierLoading(false));
  }, [isTiered, tierOpen, tierLevel, tierScopeValue, companyId, companyQS, horizonQS, apiBase]);

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
  const buildExportData = (specs: Specialisation[], levelLabel: string, filterValue: string) => {
    const rows: Record<string, string | number>[] = [];
    for (const spec of specs) {
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
    for (const spec of globalSpecs) {
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

  const renderGlobalExport = (align: "left" | "right") =>
    globalSpecs.length > 0 ? (
      <ExportMenu
        show={showExportGlobal}
        setShow={setShowExportGlobal}
        data={gdStyleGlobal ? buildGlobalDiamondExport() : buildExportData(globalSpecs, "Global", "Global")}
        columns={gdStyleGlobal ? gdExportCols : exportCols}
        filename={`${sectionSlug}-global${horizonSuffix}`}
        align={align}
      />
    ) : null;

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
            {globalOnly && renderGlobalExport("right")}
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

      {meta && meta.levels.length === 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          No compliance data configured for <strong>{programName}</strong>. Add requirements in{" "}
          <a href="/admin/program-data" className="text-blue-600 hover:underline">Admin &rsaquo; Program Data</a>{" "}
          using this program name.
        </div>
      )}

      {/* Tier Status (tiered programs) */}
      {isTiered && (
        <section className="mb-6">
          <button
            onClick={() => setTierOpen((p) => !p)}
            className="w-full flex items-center gap-2 p-4 bg-white rounded-lg border border-gray-200 hover:bg-gray-50"
          >
            {tierOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <Layers size={20} className="text-indigo-600" />
            <span className="text-lg font-semibold">Tier Status</span>
          </button>
          {tierOpen && (
            <div className="mt-2 bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <select
                  value={tierLevel}
                  onChange={(e) => { setTierLevel(e.target.value); setTierScopeValue(""); }}
                  className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                >
                  {hasGlobal && <option value="global">Global</option>}
                  {hasTheatre && <option value="theatre">By Theatre</option>}
                  {hasCountry && <option value="country">By Country</option>}
                </select>
                {tierLevel === "country" && (
                  <select
                    value={tierScopeValue}
                    onChange={(e) => setTierScopeValue(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm min-w-[200px]"
                  >
                    <option value="">Select a country...</option>
                    {countries.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
                {tierLevel === "theatre" && (
                  <select
                    value={tierScopeValue}
                    onChange={(e) => setTierScopeValue(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm min-w-[200px]"
                  >
                    <option value="">Select a theatre...</option>
                    {theatres.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
              </div>
              {tierLoading ? (
                <LoadingSpinner />
              ) : tierNeedsScope ? (
                <p className="text-sm text-gray-500">Select a {tierLevel} to view tier status.</p>
              ) : !tierBlock ? (
                <p className="text-sm text-gray-500">No tier data for this program.</p>
              ) : (
                <TierLadder block={tierBlock} />
              )}
            </div>
          )}
        </section>
      )}

      {/* Country Report */}
      {hasCountry && (
        <section className="mb-6">
          <button
            onClick={() => setCountryOpen((p) => !p)}
            className="w-full flex items-center gap-2 p-4 bg-white rounded-lg border border-gray-200 hover:bg-gray-50"
          >
            {countryOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <MapPin size={20} className="text-blue-600" />
            <span className="text-lg font-semibold">Country Report</span>
          </button>
          {countryOpen && (
            <div className="mt-2 bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3 mb-4">
                <select
                  value={selectedCountry}
                  onChange={(e) => setSelectedCountry(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm min-w-[200px]"
                >
                  <option value="">Select a country...</option>
                  {countries.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                {selectedCountry && countrySpecs.length > 0 && (
                  <ExportMenu
                    show={showExportCountry}
                    setShow={setShowExportCountry}
                    data={buildExportData(countrySpecs, "Country", selectedCountry)}
                    columns={exportCols}
                    filename={`${sectionSlug}-country-${selectedCountry}${horizonSuffix}`}
                  />
                )}
              </div>
              {countryLoading ? (
                <LoadingSpinner />
              ) : !selectedCountry ? (
                <p className="text-sm text-gray-500">Select a country to view compliance data.</p>
              ) : countrySpecs.length === 0 ? (
                <p className="text-sm text-gray-500">No country-level requirements found for this program.</p>
              ) : (
                <ComplianceTable
                  specialisations={countrySpecs}
                  level="country"
                  filterValue={selectedCountry}
                  onViewStudents={viewStudents}
                  unitLabel="people"
                />
              )}
            </div>
          )}
        </section>
      )}

      {/* Region Report (derived from country-level requirements) */}
      {hasCountry && (
        <section className="mb-6">
          <button
            onClick={() => setRegionOpen((p) => !p)}
            className="w-full flex items-center gap-2 p-4 bg-white rounded-lg border border-gray-200 hover:bg-gray-50"
          >
            {regionOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <Map size={20} className="text-teal-600" />
            <span className="text-lg font-semibold">Region Report</span>
          </button>
          {regionOpen && (
            <div className="mt-2 bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3 mb-4">
                <select
                  value={selectedRegion}
                  onChange={(e) => setSelectedRegion(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm min-w-[200px]"
                >
                  <option value="">Select a region...</option>
                  {regions.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                {selectedRegion && regionSpecs.length > 0 && (
                  <ExportMenu
                    show={showExportRegion}
                    setShow={setShowExportRegion}
                    data={buildExportData(regionSpecs, "Region", selectedRegion)}
                    columns={exportCols}
                    filename={`${sectionSlug}-region-${selectedRegion}${horizonSuffix}`}
                  />
                )}
              </div>
              {regionLoading ? (
                <LoadingSpinner />
              ) : !selectedRegion ? (
                <p className="text-sm text-gray-500">Select a region to view compliance data across all countries in that region.</p>
              ) : regionSpecs.length === 0 ? (
                <p className="text-sm text-gray-500">No country-level requirements found for this program.</p>
              ) : (
                <ComplianceTable
                  specialisations={regionSpecs}
                  level="region"
                  filterValue={selectedRegion}
                  onViewStudents={viewStudents}
                  unitLabel="people"
                />
              )}
            </div>
          )}
        </section>
      )}

      {/* Theatre Report */}
      {hasTheatre && (
        <section className="mb-6">
          <button
            onClick={() => setTheatreOpen((p) => !p)}
            className="w-full flex items-center gap-2 p-4 bg-white rounded-lg border border-gray-200 hover:bg-gray-50"
          >
            {theatreOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <Building2 size={20} className="text-purple-600" />
            <span className="text-lg font-semibold">Theatre Report</span>
          </button>
          {theatreOpen && (
            <div className="mt-2 bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3 mb-4">
                <select
                  value={selectedTheatre}
                  onChange={(e) => setSelectedTheatre(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm min-w-[200px]"
                >
                  <option value="">Select a theatre...</option>
                  {theatres.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                {selectedTheatre && theatreSpecs.length > 0 && (
                  <ExportMenu
                    show={showExportTheatre}
                    setShow={setShowExportTheatre}
                    data={buildExportData(theatreSpecs, "Theatre", selectedTheatre)}
                    columns={exportCols}
                    filename={`${sectionSlug}-theatre-${selectedTheatre}${horizonSuffix}`}
                  />
                )}
              </div>
              {theatreLoading ? (
                <LoadingSpinner />
              ) : !selectedTheatre ? (
                <p className="text-sm text-gray-500">Select a theatre to view compliance data.</p>
              ) : theatreSpecs.length === 0 ? (
                <p className="text-sm text-gray-500">No theatre-level requirements found for this program.</p>
              ) : (
                <ComplianceTable
                  specialisations={theatreSpecs}
                  level="theatre"
                  filterValue={selectedTheatre}
                  onViewStudents={viewStudents}
                  unitLabel="people"
                />
              )}
            </div>
          )}
        </section>
      )}

      {/* Global Report */}
      {hasGlobal && (
        <section className="mb-6">
          <button
            onClick={() => setGlobalOpen((p) => !p)}
            className="w-full flex items-center gap-2 p-4 bg-white rounded-lg border border-gray-200 hover:bg-gray-50"
          >
            {globalOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <Globe size={20} className="text-green-600" />
            <span className="text-lg font-semibold">Global Report</span>
          </button>
          {globalOpen && (
            <div className="mt-2">
              {/* In a global-only view the export lives in the page header. */}
              {!globalOnly && globalSpecs.length > 0 && (
                <div className="flex items-center gap-3 mb-4">{renderGlobalExport("left")}</div>
              )}
              {globalLoading ? (
                <LoadingSpinner />
              ) : globalSpecs.length === 0 ? (
                <p className="text-sm text-gray-500">No global-level requirements found for this program.</p>
              ) : gdStyleGlobal ? (
                globalSpecs.map((spec) => <SpecialisationCard key={spec.name} spec={spec} />)
              ) : (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <ComplianceTable
                    specialisations={globalSpecs}
                    level="global"
                    filterValue=""
                    onViewStudents={viewStudents}
                    unitLabel="theatres"
                  />
                </div>
              )}
            </div>
          )}
        </section>
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
