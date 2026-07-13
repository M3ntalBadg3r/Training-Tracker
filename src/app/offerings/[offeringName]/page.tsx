"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { ExportMenu } from "@/components/programs/ProgramCompliance";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";
import { trainingTypeLabel } from "@/lib/utils";
import { ExternalLink, Users, Ship, Anchor } from "lucide-react";

interface AltOut {
  trainingType: string;
  trainingTitle: string;
  trainingFullTitle: string;
}
interface ReqOut {
  id: number;
  trainingType: string | null;
  trainingTitle: string | null;
  trainingFullTitle: string;
  quantityRequired: number;
  alternatives: AltOut[];
  onshore: number | null;
  offshore: number | null;
  met: boolean | null;
}
interface SpecOut {
  name: string;
  requirements: ReqOut[];
  met: boolean | null;
}
interface GeoOut {
  level: string;
  value: string;
  theatres: string[];
  onshoreCountries: string[];
  offshoreCountries: string[];
  hasOffshore: boolean;
  scopeLabel: string;
}
interface OfferingResponse {
  name: string;
  description: string | null;
  link: string | null;
  countries: string[];
  regions: string[];
  specialisations: SpecOut[];
  geo: GeoOut | null;
}
interface StudentRow {
  fullName: string;
  email: string;
  country: string;
  theatre: string;
  completedDate: string;
  expiryDate: string;
  training: string;
}

export default function OfferingDashboardPage() {
  const params = useParams();
  const offeringName = decodeURIComponent(String(params.offeringName));
  const scope = useCompanyScope();

  const companyId = useMemo(() => {
    if (scope.selected !== "all") return scope.selected;
    return scope.companies[0]?.id ?? null;
  }, [scope.selected, scope.companies]);
  const companyQS = companyId != null ? `&companyId=${companyId}` : "";

  const [data, setData] = useState<OfferingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [level, setLevel] = useState<"country" | "region">("country");
  const [value, setValue] = useState("");
  const [showExport, setShowExport] = useState(false);

  // Students modal
  const [students, setStudents] = useState<StudentRow[] | null>(null);
  const [studentsTitle, setStudentsTitle] = useState("");
  const [studentsLoading, setStudentsLoading] = useState(false);

  const apiBase = `/api/offerings/${encodeURIComponent(offeringName)}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ level });
      if (value) qs.set(level, value);
      const res = await fetch(`${apiBase}?${qs.toString()}${companyQS}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [apiBase, level, value, companyQS]);

  useEffect(() => {
    if (scope.loading) return;
    load();
  }, [load, scope.loading]);

  // Reset the selected value when switching level dimension.
  const changeLevel = (l: "country" | "region") => {
    setLevel(l);
    setValue("");
  };

  const viewStudents = async (req: ReqOut, side: "onshore" | "offshore") => {
    if (!value) return;
    const titles = [req.trainingTitle, ...req.alternatives.map((a) => a.trainingTitle)].filter(Boolean).join(",");
    setStudentsTitle(`${req.trainingFullTitle} — ${side === "onshore" ? "Onshore" : "Offshore"}`);
    setStudents(null);
    setStudentsLoading(true);
    try {
      const qs = new URLSearchParams({ students: "true", scope: side, level, trainingTitle: titles });
      qs.set(level, value);
      const res = await fetch(`${apiBase}?${qs.toString()}${companyQS}`);
      if (res.ok) setStudents((await res.json()).students || []);
      else setStudents([]);
    } finally {
      setStudentsLoading(false);
    }
  };

  const scopeValues = level === "country" ? data?.countries ?? [] : data?.regions ?? [];
  const hasScope = value !== "";

  // Export rows (only meaningful once a scope is picked).
  const exportColumns = [
    { key: "specialisation", header: "Specialisation" },
    { key: "trainingType", header: "Type" },
    { key: "training", header: "Training" },
    { key: "minRequired", header: "Min Required" },
    { key: "onshore", header: "Onshore" },
    { key: "offshore", header: "Offshore" },
    { key: "met", header: "Met" },
  ];
  const exportData: Record<string, string | number>[] = (data?.specialisations ?? []).flatMap((s) =>
    s.requirements.map((r) => ({
      specialisation: s.name,
      trainingType: r.trainingType ? trainingTypeLabel(r.trainingType) : "",
      training: r.trainingFullTitle,
      minRequired: r.quantityRequired,
      onshore: r.onshore ?? 0,
      offshore: r.offshore ?? "—",
      met: r.met === null ? "" : r.met ? "Yes" : "No",
    }))
  );
  const exportFilename = `offering-${offeringName}-${level}${value ? `-${value}` : ""}`.replace(/\s+/g, "-");

  return (
    <div>
      <PageHeader
        title={data?.name ?? offeringName}
        showBack
        helpSlug="offerings"
        rightContent={hasScope && exportData.length > 0 ? (
          <ExportMenu show={showExport} setShow={setShowExport} data={exportData} columns={exportColumns} filename={exportFilename} align="right" />
        ) : undefined}
      />

      {/* Offering details */}
      {data && (
        <div className="mb-4 border border-gray-200 rounded-xl p-4 bg-white">
          {data.description ? <p className="text-sm text-gray-700">{data.description}</p> : <p className="text-sm text-gray-400 italic">No description</p>}
          {data.link && (
            <a href={data.link} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800">
              <ExternalLink size={14} /> {data.link}
            </a>
          )}
        </div>
      )}

      {/* Scope selector */}
      <div className="mb-6 flex flex-wrap items-end gap-3 bg-white border border-gray-200 rounded-xl p-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">View by</label>
          <select value={level} onChange={(e) => changeLevel(e.target.value as "country" | "region")} className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm">
            <option value="country">Country</option>
            <option value="region">Region</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">{level === "country" ? "Country" : "Region"}</label>
          <select value={value} onChange={(e) => setValue(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm min-w-[200px]">
            <option value="">Select a {level}…</option>
            {scopeValues.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        {hasScope && data?.geo && (
          <p className="text-xs text-gray-500 pb-2">
            Onshore: {data.geo.onshoreCountries.length} country(ies) · Offshore: {data.geo.hasOffshore ? `${data.geo.offshoreCountries.length} country(ies) in ${data.geo.theatres.join(", ")}` : "theatre unknown"}
          </p>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : !hasScope ? (
        <div className="bg-white rounded-lg border border-dashed border-gray-200 p-10 text-center text-gray-500">
          Select a country or region to view Onshore &amp; Offshore capability.
        </div>
      ) : (data?.specialisations.length ?? 0) === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          This offering has no specialisations configured yet.
        </div>
      ) : (
        <div className="space-y-5">
          {data!.specialisations.map((spec) => (
            <div key={spec.name} className="border border-gray-200 rounded-xl bg-white overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                <h3 className="font-semibold text-gray-900">{spec.name}</h3>
                {spec.met !== null && (
                  <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${spec.met ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    {spec.met ? "Met" : "Not met"}
                  </span>
                )}
              </div>
              {spec.requirements.length === 0 ? (
                <p className="px-4 py-4 text-sm text-gray-400 italic">No supporting trainings defined.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="px-4 py-2 font-medium">Type</th>
                      <th className="px-4 py-2 font-medium">Training</th>
                      <th className="px-4 py-2 font-medium"><span className="inline-flex items-center gap-1"><Anchor size={12} /> Onshore</span></th>
                      <th className="px-4 py-2 font-medium"><span className="inline-flex items-center gap-1"><Ship size={12} /> Offshore</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {spec.requirements.map((r) => (
                      <tr key={r.id} className="border-b border-gray-50 last:border-0">
                        <td className="px-4 py-2 text-gray-600 align-top">{r.trainingType ? trainingTypeLabel(r.trainingType) : "—"}</td>
                        <td className="px-4 py-2 align-top">
                          <div className="text-gray-900">{r.trainingFullTitle}</div>
                          {r.alternatives.length > 0 && (
                            <div className="text-xs text-gray-400">or {r.alternatives.map((a) => a.trainingFullTitle).join(", ")}</div>
                          )}
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className={`font-medium ${r.met ? "text-green-700" : "text-red-700"}`}>
                            {r.onshore ?? 0} / {r.quantityRequired}
                          </span>
                          {(r.onshore ?? 0) > 0 && (
                            <button onClick={() => viewStudents(r, "onshore")} className="ml-2 inline-flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-800" title="View students">
                              <Users size={12} /> View
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-2 align-top text-gray-600">
                          {r.offshore === null ? (
                            <span className="text-gray-400">—</span>
                          ) : (
                            <>
                              {r.offshore}
                              {r.offshore > 0 && (
                                <button onClick={() => viewStudents(r, "offshore")} className="ml-2 inline-flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-800" title="View students">
                                  <Users size={12} /> View
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Students modal */}
      <Modal open={students !== null || studentsLoading} onClose={() => { setStudents(null); }} title={studentsTitle}>
        {studentsLoading ? (
          <div className="py-8 text-center text-gray-500">Loading…</div>
        ) : students && students.length > 0 ? (
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                  <th className="px-2 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium">Country</th>
                  <th className="px-2 py-2 font-medium">Completed</th>
                  <th className="px-2 py-2 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => (
                  <tr key={s.email} className="border-b border-gray-50">
                    <td className="px-2 py-2"><Link href={`/students/${encodeURIComponent(s.email)}`} className="text-blue-600 hover:underline">{s.fullName}</Link></td>
                    <td className="px-2 py-2 text-gray-600">{s.country}</td>
                    <td className="px-2 py-2 text-gray-600">{s.completedDate}</td>
                    <td className="px-2 py-2 text-gray-600">{s.expiryDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-8 text-center text-gray-500">No students found.</div>
        )}
      </Modal>
    </div>
  );
}
