"use client";

import { useEffect, useState, useMemo } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Users,
  Globe,
  Building2,
  MapPin,
  Map,
  ExternalLink,
} from "lucide-react";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";

const TRAINING_TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
  InstructorLedTraining: "Instructor-Led Training",
};

interface AlternativeEntry {
  trainingType: string;
  trainingTitle: string;
  trainingFullTitle: string;
}

interface Requirement {
  trainingType: string;
  trainingTitle: string;
  trainingFullTitle: string;
  quantityRequired: number;
  attained: number;
  alternatives: AlternativeEntry[];
}

interface Specialisation {
  name: string;
  requirements: Requirement[];
}

interface StudentEntry {
  fullName: string;
  email: string;
  country: string;
  theatre: string;
  completedDate: string;
  expiryDate: string;
}

export default function APSPage() {
  const companyScope = useCompanyScope();
  // Compliance is per-company; force a single-company selection.
  const [aPSCompanyId, setAPSCompanyId] = useState<number | null>(null);
  useEffect(() => {
    if (companyScope.loading) return;
    if (companyScope.selected !== "all") {
      setAPSCompanyId(companyScope.selected);
    } else if (companyScope.companies.length > 0) {
      setAPSCompanyId((prev) => prev ?? companyScope.companies[0].id);
    }
  }, [companyScope.loading, companyScope.selected, companyScope.companies]);
  const companyQS = aPSCompanyId !== null ? `&companyId=${aPSCompanyId}` : "";
  const [countries, setCountries] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [theatres, setTheatres] = useState<string[]>([]);

  // Country report
  const [countryOpen, setCountryOpen] = useState(true);
  const [selectedCountry, setSelectedCountry] = useState("");
  const [countrySpecs, setCountrySpecs] = useState<Specialisation[]>([]);
  const [countryLoading, setCountryLoading] = useState(false);

  // Region report
  const [regionOpen, setRegionOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState("");
  const [regionSpecs, setRegionSpecs] = useState<Specialisation[]>([]);
  const [regionLoading, setRegionLoading] = useState(false);

  // Theatre report
  const [theatreOpen, setTheatreOpen] = useState(false);
  const [selectedTheatre, setSelectedTheatre] = useState("");
  const [theatreSpecs, setTheatreSpecs] = useState<Specialisation[]>([]);
  const [theatreLoading, setTheatreLoading] = useState(false);

  // Global report
  const [globalOpen, setGlobalOpen] = useState(false);
  const [globalSpecs, setGlobalSpecs] = useState<Specialisation[]>([]);
  const [globalLoading, setGlobalLoading] = useState(false);

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

  // Initial load - get available countries/theatres (scoped to selected company)
  useEffect(() => {
    if (aPSCompanyId === null) return;
    fetch(`/api/programs/aps?level=country${companyQS}`)
      .then((r) => r.json())
      .then((data) => {
        setCountries(data.countries || []);
        setRegions(data.regions || []);
        setTheatres(data.theatres || []);
      })
      .catch(() => {});
  }, [aPSCompanyId, companyQS]);

  // Fetch country report
  useEffect(() => {
    if (!selectedCountry || aPSCompanyId === null) {
      setCountrySpecs([]);
      return;
    }
    setCountryLoading(true);
    fetch(`/api/programs/aps?level=country&country=${encodeURIComponent(selectedCountry)}${companyQS}`)
      .then((r) => r.json())
      .then((data) => {
        setCountrySpecs(data.specialisations || []);
      })
      .catch(() => {})
      .finally(() => setCountryLoading(false));
  }, [selectedCountry, aPSCompanyId, companyQS]);

  // Fetch region report
  useEffect(() => {
    if (!selectedRegion || aPSCompanyId === null) {
      setRegionSpecs([]);
      return;
    }
    setRegionLoading(true);
    fetch(`/api/programs/aps?level=region&region=${encodeURIComponent(selectedRegion)}${companyQS}`)
      .then((r) => r.json())
      .then((data) => {
        setRegionSpecs(data.specialisations || []);
      })
      .catch(() => {})
      .finally(() => setRegionLoading(false));
  }, [selectedRegion, aPSCompanyId, companyQS]);

  // Fetch theatre report
  useEffect(() => {
    if (!selectedTheatre || aPSCompanyId === null) {
      setTheatreSpecs([]);
      return;
    }
    setTheatreLoading(true);
    fetch(`/api/programs/aps?level=theatre&theatre=${encodeURIComponent(selectedTheatre)}${companyQS}`)
      .then((r) => r.json())
      .then((data) => {
        setTheatreSpecs(data.specialisations || []);
      })
      .catch(() => {})
      .finally(() => setTheatreLoading(false));
  }, [selectedTheatre, aPSCompanyId, companyQS]);

  // Fetch global report
  useEffect(() => {
    if (!globalOpen || aPSCompanyId === null) return;
    setGlobalLoading(true);
    fetch(`/api/programs/aps?level=global${companyQS}`)
      .then((r) => r.json())
      .then((data) => {
        setGlobalSpecs(data.specialisations || []);
      })
      .catch(() => {})
      .finally(() => setGlobalLoading(false));
  }, [globalOpen, aPSCompanyId, companyQS]);

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

    // Pass all titles (primary + alternatives) as comma-separated
    const allTitles = [trainingTitle, ...(alternatives || []).map((a) => a.trainingTitle)].filter(Boolean);
    const params = new URLSearchParams({
      students: "true",
      trainingTitle: allTitles.join(","),
      level,
    });
    if (level === "country") params.set("country", filterValue);
    if (level === "region") params.set("region", filterValue);
    if (level === "theatre") params.set("theatre", filterValue);

    try {
      if (aPSCompanyId !== null) params.set("companyId", String(aPSCompanyId));
      const res = await fetch(`/api/programs/aps?${params}`);
      const data = await res.json();
      setStudentList(data.students || []);
    } catch {
      setStudentList([]);
    } finally {
      setStudentLoading(false);
    }
  };

  // Build flat export data from specialisations
  const buildExportData = (specs: Specialisation[], levelLabel: string, filterValue: string) => {
    const rows: Record<string, string | number>[] = [];
    for (const spec of specs) {
      for (const req of spec.requirements) {
        let trainingLabel = req.trainingFullTitle;
        if (req.alternatives && req.alternatives.length > 0) {
          trainingLabel += " (or " + req.alternatives.map((a) => a.trainingFullTitle).join(", ") + ")";
        }
        rows.push({
          specialisation: spec.name,
          training: trainingLabel,
          type: TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType,
          required: req.quantityRequired,
          attained: req.attained,
          compliant: req.attained >= req.quantityRequired ? "Yes" : "No",
          level: levelLabel,
          filter: filterValue,
        });
      }
    }
    return rows;
  };

  const exportCols = [
    { key: "specialisation", header: "Specialisation" },
    { key: "training", header: "Training" },
    { key: "type", header: "Type" },
    { key: "required", header: "Required" },
    { key: "attained", header: "Attained" },
    { key: "compliant", header: "Compliant" },
    { key: "level", header: "Level" },
    { key: "filter", header: "Filter" },
  ];

  return (
    <div>
      <PageHeader
        title="APS — Authorized Professional Services"
        helpSlug="programs-aps"
        rightContent={
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-500">Company</label>
            <select
              value={aPSCompanyId ?? ""}
              onChange={(e) => setAPSCompanyId(e.target.value ? Number(e.target.value) : null)}
              className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white"
            >
              {companyScope.companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        }
      />

      {/* Country Report */}
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
                  filename={`aps-country-${selectedCountry}`}
                />
              )}
            </div>
            {countryLoading ? (
              <LoadingSpinner />
            ) : !selectedCountry ? (
              <p className="text-sm text-gray-500">Select a country to view compliance data.</p>
            ) : countrySpecs.length === 0 ? (
              <p className="text-sm text-gray-500">No country-level requirements found for the APS program.</p>
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

      {/* Region Report */}
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
                  filename={`aps-region-${selectedRegion}`}
                />
              )}
            </div>
            {regionLoading ? (
              <LoadingSpinner />
            ) : !selectedRegion ? (
              <p className="text-sm text-gray-500">Select a region to view compliance data across all countries in that region.</p>
            ) : regionSpecs.length === 0 ? (
              <p className="text-sm text-gray-500">No country-level requirements found for the APS program.</p>
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

      {/* Theatre Report */}
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
                  filename={`aps-theatre-${selectedTheatre}`}
                />
              )}
            </div>
            {theatreLoading ? (
              <LoadingSpinner />
            ) : !selectedTheatre ? (
              <p className="text-sm text-gray-500">Select a theatre to view compliance data.</p>
            ) : theatreSpecs.length === 0 ? (
              <p className="text-sm text-gray-500">No theatre-level requirements found for the APS program.</p>
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

      {/* Global Report */}
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
          <div className="mt-2 bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3 mb-4">
              {globalSpecs.length > 0 && (
                <ExportMenu
                  show={showExportGlobal}
                  setShow={setShowExportGlobal}
                  data={buildExportData(globalSpecs, "Global", "Global")}
                  columns={exportCols}
                  filename="aps-global"
                />
              )}
            </div>
            {globalLoading ? (
              <LoadingSpinner />
            ) : globalSpecs.length === 0 ? (
              <p className="text-sm text-gray-500">No global-level requirements found for the APS program.</p>
            ) : (
              <ComplianceTable
                specialisations={globalSpecs}
                level="global"
                filterValue=""
                onViewStudents={viewStudents}
                unitLabel="theatres"
              />
            )}
          </div>
        )}
      </section>

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

function ComplianceTable({
  specialisations,
  level,
  filterValue,
  onViewStudents,
  unitLabel,
}: {
  specialisations: Specialisation[];
  level: string;
  filterValue: string;
  onViewStudents: (trainingTitle: string, trainingFullTitle: string, level: string, filterValue: string, alternatives?: AlternativeEntry[]) => void;
  unitLabel: string;
}) {
  // Find the max number of requirements across specialisations to determine row count
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
  onViewStudents: (trainingTitle: string, trainingFullTitle: string, level: string, filterValue: string, alternatives?: AlternativeEntry[]) => void;
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
            <td
              key={spec.name}
              className="px-4 py-2 text-center border border-gray-200"
            >
              {req ? (
                <div>
                  <div className="font-medium">{req.trainingFullTitle}</div>
                  <div className="text-xs text-gray-500">
                    {TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType}
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
            <td
              key={spec.name}
              className="px-4 py-2 text-center border border-gray-200"
            >
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
              className={`px-4 py-2 text-center border border-gray-200 ${
                compliant
                  ? "bg-green-50"
                  : "bg-red-50"
              }`}
            >
              <span
                className={`font-bold ${
                  compliant
                    ? "text-green-700"
                    : "text-red-700"
                }`}
              >
                {req.attained} {unitLabel}
              </span>
              {level !== "global" && (
                <button
                  onClick={() => onViewStudents(req.trainingTitle, req.trainingFullTitle, level, filterValue, req.alternatives)}
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
        <td
          colSpan={specialisations.length + 1}
          className="h-1 bg-gray-100 border-0"
        />
      </tr>
    </>
  );
}

function ExportMenu({
  show,
  setShow,
  data,
  columns,
  filename,
}: {
  show: boolean;
  setShow: (v: boolean) => void;
  data: Record<string, string | number>[];
  columns: { key: string; header: string }[];
  filename: string;
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
        <div className="absolute left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
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

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
    </div>
  );
}
