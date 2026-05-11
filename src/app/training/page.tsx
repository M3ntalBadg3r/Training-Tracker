"use client";

import { useEffect, useState, useCallback, useMemo, Suspense } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Download } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";
import DataTable from "@/components/data-table/DataTable";
import { ColumnDef, TrainingAvailableRow } from "@/types";
import { trainingTypeLabel, functionTypeLabel } from "@/lib/utils";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";

interface FilterOptions {
  theatres: string[];
  regions: string[];
  countries: string[];
}

const columns: ColumnDef<TrainingAvailableRow>[] = [
  { key: "fullTitle", header: "Full Title" },
  {
    key: "trainingType",
    header: "Training Type",
    accessor: (row) => trainingTypeLabel(row.trainingType),
  },
  { key: "productType", header: "Product Type" },
  {
    key: "function",
    header: "Function",
    accessor: (row) => functionTypeLabel(row.function),
  },
  {
    key: "link",
    header: "Link",
    render: (row) =>
      row.link ? (
        <a
          href={row.link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline"
        >
          Link
        </a>
      ) : (
        <span className="text-gray-400">-</span>
      ),
    filterable: false,
    sortable: false,
  },
  {
    key: "studentsTaken",
    header: "Students Taken",
    accessor: (row) => row.studentsTaken,
  },
];

function TrainingPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { selected, loading: scopeLoading } = useCompanyScope();
  const [training, setTraining] = useState<TrainingAvailableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ theatres: [], regions: [], countries: [] });

  // Filters are mirrored to the URL so that navigating into a training and
  // back (router.back()) restores them.
  const theatre = searchParams.get("theatre") ?? "";
  const region = searchParams.get("region") ?? "";
  const country = searchParams.get("country") ?? "";
  const activeOnly = searchParams.get("active") === "true";

  const updateFilter = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [searchParams, pathname, router]
  );

  const fetchTraining = useCallback(() => {
    if (scopeLoading) return;
    const params = new URLSearchParams();
    if (theatre) params.set("theatre", theatre);
    if (region) params.set("region", region);
    if (country) params.set("country", country);
    if (activeOnly) params.set("active", "true");
    const qs = params.toString();
    const base = `/api/training-data${qs ? `?${qs}` : ""}`;
    setLoading(true);
    fetch(withCompany(base, selected))
      .then((res) => res.json())
      .then((data) => {
        setTraining(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [theatre, region, country, activeOnly, selected, scopeLoading]);

  useEffect(() => {
    fetchTraining();
  }, [fetchTraining]);

  useEffect(() => {
    fetch("/api/training-data/filters")
      .then((res) => res.json())
      .then((data) => setFilterOptions(data))
      .catch(() => {});
    fetch("/api/import-metadata?key=training-data")
      .then((res) => res.json())
      .then((data) => {
        if (data?.timestamp) setLastImport(data.timestamp);
      })
      .catch(() => {});
  }, []);

  const [showExportMenu, setShowExportMenu] = useState(false);

  const exportData = useMemo(
    () =>
      training.map((r) => ({
        fullTitle: r.fullTitle,
        trainingType: trainingTypeLabel(r.trainingType),
        productType: r.productType,
        function: functionTypeLabel(r.function),
        link: r.link ?? "",
        studentsTaken: r.studentsTaken,
      })),
    [training]
  );

  const exportColumns: { key: keyof (typeof exportData)[0]; header: string }[] = [
    { key: "fullTitle", header: "Full Title" },
    { key: "trainingType", header: "Training Type" },
    { key: "productType", header: "Product Type" },
    { key: "function", header: "Function" },
    { key: "link", header: "Link" },
    { key: "studentsTaken", header: "Students Taken" },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading training data...</div>
      </div>
    );
  }

  const hasFilters = !!(theatre || region || country || activeOnly);

  return (
    <div>
      <PageHeader
        title="Training"
        helpSlug="training"
        rightContent={
          lastImport && (
            <span className="text-sm text-gray-500">
              Last imported: {new Date(lastImport).toLocaleString()}
            </span>
          )
        }
      />
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={theatre}
            onChange={(e) => updateFilter({ theatre: e.target.value || null })}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Theatres</option>
            {filterOptions.theatres.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select
            value={region}
            onChange={(e) => updateFilter({ region: e.target.value || null })}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Regions</option>
            {filterOptions.regions.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <select
            value={country}
            onChange={(e) => updateFilter({ country: e.target.value || null })}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Countries</option>
            {filterOptions.countries.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-gray-700 select-none">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => updateFilter({ active: e.target.checked ? "true" : null })}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Active only
          </label>
          {hasFilters && (
            <button
              onClick={() => updateFilter({ theatre: null, region: null, country: null, active: null })}
              className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
        {training.length > 0 && (
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
                    exportToCsv(exportData, exportColumns, "training");
                    setShowExportMenu(false);
                  }}
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg"
                >
                  Export as CSV
                </button>
                <button
                  onClick={() => {
                    exportToExcel(exportData, exportColumns, "training");
                    setShowExportMenu(false);
                  }}
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
                >
                  Export as Excel
                </button>
                <button
                  onClick={() => {
                    exportToPdf(exportData, exportColumns, "training");
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

      <DataTable<TrainingAvailableRow>
        data={training}
        columns={columns}
        rowAction={{
          label: "View Students",
          onClick: (row) => {
            const params = new URLSearchParams();
            params.set("trainingType", row.trainingType);
            if (theatre) params.set("theatre", theatre);
            if (region) params.set("region", region);
            if (country) params.set("country", country);
            if (activeOnly) params.set("active", "true");
            if (selected !== "all") params.set("companyId", String(selected));
            router.push(`/training/${encodeURIComponent(row.fullTitle)}?${params.toString()}`);
          },
        }}
      />
    </div>
  );
}

export default function TrainingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading training data...</div>
        </div>
      }
    >
      <TrainingPageInner />
    </Suspense>
  );
}
