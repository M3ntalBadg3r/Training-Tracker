"use client";

import { useEffect, useState, useMemo, use } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Download } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";
import DataTable from "@/components/data-table/DataTable";
import Badge from "@/components/ui/Badge";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { ColumnDef, TrainingTakenRow } from "@/types";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";

const columns: ColumnDef<TrainingTakenRow>[] = [
  { key: "fullName", header: "Full Name" },
  { key: "email", header: "Email Address" },
  { key: "theatre", header: "Theatre" },
  { key: "region", header: "Region" },
  { key: "country", header: "Country" },
  {
    key: "active",
    header: "Active",
    render: (row) => <Badge active={row.active} />,
    accessor: (row) => (row.active ? "Yes" : "No"),
  },
];

export default function TrainingTakenPage({
  params,
}: {
  params: Promise<{ fullTitle: string }>;
}) {
  const resolvedParams = use(params);
  const fullTitle = decodeURIComponent(resolvedParams.fullTitle);
  const searchParams = useSearchParams();
  const trainingType = searchParams.get("trainingType");
  const theatre = searchParams.get("theatre");
  const region = searchParams.get("region");
  const country = searchParams.get("country");
  const activeOnly = searchParams.get("active") === "true";
  const urlCompanyId = searchParams.get("companyId");
  const hasLocationFilters = !!(theatre || region || country);
  const router = useRouter();
  const { selected, loading: scopeLoading } = useCompanyScope();
  const { formatDate } = useDateFormat();

  const [students, setStudents] = useState<TrainingTakenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [subItems, setSubItems] = useState<{ trainingTitle: string; fullTitle: string }[]>([]);
  const [legacy, setLegacy] = useState<{ replacedBy: string[] } | null>(null);

  const exportData = useMemo(
    () =>
      students.map((s) => ({
        fullName: s.fullName,
        email: s.email,
        theatre: s.theatre,
        region: s.region,
        country: s.country,
        completedDate: formatDate(s.completedDate),
        expiryDate: formatDate(s.expiryDate),
        active: s.active ? "Yes" : "No",
      })),
    [students, formatDate]
  );

  const exportColumns: { key: keyof (typeof exportData)[0]; header: string }[] = [
    { key: "fullName", header: "Full Name" },
    { key: "email", header: "Email Address" },
    { key: "theatre", header: "Theatre" },
    { key: "region", header: "Region" },
    { key: "country", header: "Country" },
    { key: "completedDate", header: "Completed Date" },
    { key: "expiryDate", header: "Expiry Date" },
    { key: "active", header: "Active" },
  ];

  useEffect(() => {
    if (scopeLoading) return;
    const url = new URL(`/api/training-taken`, window.location.origin);
    url.searchParams.set("fullTitle", fullTitle);
    if (trainingType) url.searchParams.set("trainingType", trainingType);
    if (theatre) url.searchParams.set("theatre", theatre);
    if (region) url.searchParams.set("region", region);
    if (country) url.searchParams.set("country", country);
    if (activeOnly) url.searchParams.set("active", "true");
    // Prefer URL-passed companyId (from training page navigation), fall back to context selection
    const companyId = urlCompanyId ?? (selected !== "all" ? String(selected) : null);
    if (companyId) url.searchParams.set("companyId", companyId);
    fetch(url.toString())
      .then((res) => res.json())
      .then((data) => {
        setStudents(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [fullTitle, trainingType, theatre, region, country, activeOnly, urlCompanyId, selected, scopeLoading]);

  // For OLX parents, fetch the sub-item list to display nested under this view.
  useEffect(() => {
    if (trainingType !== "OLX") {
      setSubItems([]);
      return;
    }
    fetch("/api/training-data/all")
      .then((res) => (res.ok ? res.json() : []))
      .then((all: { trainingTitle: string; fullTitle: string; trainingType: string; subItems?: string[] }[]) => {
        const parents = all.filter((t) => t.trainingType === "OLX" && t.fullTitle === fullTitle);
        const subTitles = new Set<string>();
        for (const p of parents) {
          for (const s of p.subItems || []) subTitles.add(s);
        }
        const subs = all.filter((t) => subTitles.has(t.trainingTitle));
        setSubItems(subs.map((s) => ({ trainingTitle: s.trainingTitle, fullTitle: s.fullTitle })));
      })
      .catch(() => setSubItems([]));
  }, [fullTitle, trainingType]);

  // For legacy Certifications/Accreditations, surface the replacement(s).
  useEffect(() => {
    if (trainingType !== "Certification" && trainingType !== "Accreditation") {
      setLegacy(null);
      return;
    }
    fetch("/api/training-data/all")
      .then((res) => (res.ok ? res.json() : []))
      .then((all: { trainingTitle: string; fullTitle: string; trainingType: string; isLegacy?: boolean; replacedBy?: string[] }[]) => {
        const match = all.find((t) => t.fullTitle === fullTitle && t.trainingType === trainingType && t.isLegacy);
        if (!match) {
          setLegacy(null);
          return;
        }
        const titleToFull = new Map(all.map((t) => [t.trainingTitle, t.fullTitle]));
        setLegacy({ replacedBy: (match.replacedBy || []).map((r) => titleToFull.get(r) ?? r) });
      })
      .catch(() => setLegacy(null));
  }, [fullTitle, trainingType]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={fullTitle} showBack helpSlug="training-detail" />
      {legacy && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-800">
          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-800">Legacy</span>
          {legacy.replacedBy.length > 0 ? (
            <span>Replaced by {legacy.replacedBy.join(" or ")}</span>
          ) : (
            <span>No replacement — retired</span>
          )}
        </div>
      )}
      {(hasLocationFilters || activeOnly) && (
        <div className="flex items-center gap-2 mb-3 text-sm text-gray-600">
          <span>Filtered by:</span>
          {theatre && <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded">{theatre}</span>}
          {region && <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded">{region}</span>}
          {country && <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded">{country}</span>}
          {activeOnly && <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded">Active only</span>}
        </div>
      )}
      <div className="flex items-center justify-between mb-4">
        <p className="text-gray-600">
          {students.length} student(s) have taken this training
        </p>
        {students.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setShowExportMenu((prev) => !prev)}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              <Download size={16} /> Export
            </button>
            {showExportMenu && (
              <div className="absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
                <button
                  onClick={() => {
                    exportToCsv(exportData, exportColumns, fullTitle);
                    setShowExportMenu(false);
                  }}
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg"
                >
                  Export as CSV
                </button>
                <button
                  onClick={() => {
                    exportToExcel(exportData, exportColumns, fullTitle);
                    setShowExportMenu(false);
                  }}
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
                >
                  Export as Excel
                </button>
                <button
                  onClick={() => {
                    exportToPdf(exportData, exportColumns, fullTitle);
                    setShowExportMenu(false);
                  }}
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg"
                >
                  Export as PDF
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <DataTable<TrainingTakenRow>
        data={students}
        columns={columns}
        defaultSortColumn="fullName"
        rowAction={{
          label: "View",
          onClick: (row) => router.push(`/students/${encodeURIComponent(row.email)}`),
        }}
      />

      {/* Sub-items, when this is an OLX parent. Listing them here lets users
          jump into the per-sub-item completion view. */}
      {trainingType === "OLX" && subItems.length > 0 && (
        <section className="mt-8">
          <h3 className="text-lg font-semibold mb-2">Sub-Items</h3>
          <p className="text-sm text-gray-600 mb-3">
            A student is counted as having completed this OLX once they&apos;ve completed every sub-item below.
          </p>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 text-left font-semibold text-gray-700">Full Title</th>
                  <th className="px-4 py-2 text-left font-semibold text-gray-700">Training Title</th>
                  <th className="px-4 py-2 text-left font-semibold text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {subItems.map((s) => (
                  <tr key={s.trainingTitle} className="border-b border-gray-100">
                    <td className="px-4 py-2">{s.fullTitle}</td>
                    <td className="px-4 py-2 text-gray-600">{s.trainingTitle}</td>
                    <td className="px-4 py-2">
                      <button
                        onClick={() => {
                          const params = new URLSearchParams();
                          params.set("trainingType", "OLXSubItem");
                          if (theatre) params.set("theatre", theatre);
                          if (region) params.set("region", region);
                          if (country) params.set("country", country);
                          if (activeOnly) params.set("active", "true");
                          const cid = urlCompanyId ?? (selected !== "all" ? String(selected) : null);
                          if (cid) params.set("companyId", cid);
                          router.push(`/training/${encodeURIComponent(s.fullTitle)}?${params.toString()}`);
                        }}
                        className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                      >
                        View Students
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
