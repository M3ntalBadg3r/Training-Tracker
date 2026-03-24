"use client";

import { useEffect, useState, useMemo, use } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Download } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";
import DataTable from "@/components/data-table/DataTable";
import Badge from "@/components/ui/Badge";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { ColumnDef, TrainingTakenRow } from "@/types";

const columns: ColumnDef<TrainingTakenRow>[] = [
  { key: "fullName", header: "Full Name" },
  { key: "email", header: "Email Address" },
  { key: "theatre", header: "Theatre" },
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
  const hasLocationFilters = !!(theatre || region || country);
  const router = useRouter();

  const [students, setStudents] = useState<TrainingTakenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const exportData = useMemo(
    () =>
      students.map((s) => ({
        fullName: s.fullName,
        email: s.email,
        theatre: s.theatre,
        country: s.country,
        completedDate: s.completedDate,
        expiryDate: s.expiryDate,
        active: s.active ? "Yes" : "No",
      })),
    [students]
  );

  const exportColumns: { key: keyof (typeof exportData)[0]; header: string }[] = [
    { key: "fullName", header: "Full Name" },
    { key: "email", header: "Email Address" },
    { key: "theatre", header: "Theatre" },
    { key: "country", header: "Country" },
    { key: "completedDate", header: "Completed Date" },
    { key: "expiryDate", header: "Expiry Date" },
    { key: "active", header: "Active" },
  ];

  useEffect(() => {
    const url = new URL(`/api/training-taken`, window.location.origin);
    url.searchParams.set("fullTitle", fullTitle);
    if (trainingType) url.searchParams.set("trainingType", trainingType);
    if (theatre) url.searchParams.set("theatre", theatre);
    if (region) url.searchParams.set("region", region);
    if (country) url.searchParams.set("country", country);
    fetch(url.toString())
      .then((res) => res.json())
      .then((data) => {
        setStudents(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [fullTitle, trainingType, theatre, region, country]);

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
      {hasLocationFilters && (
        <div className="flex items-center gap-2 mb-3 text-sm text-gray-600">
          <span>Filtered by:</span>
          {theatre && <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded">{theatre}</span>}
          {region && <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded">{region}</span>}
          {country && <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded">{country}</span>}
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
        rowAction={{
          label: "View",
          onClick: (row) => router.push(`/students/${encodeURIComponent(row.email)}`),
        }}
      />
    </div>
  );
}
