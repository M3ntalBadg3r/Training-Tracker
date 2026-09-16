"use client";

import { useEffect, useState, useCallback, useMemo, Suspense } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useFetchJson } from "@/hooks/useFetchJson";
import PageHeader from "@/components/layout/PageHeader";
import ExportMenu from "@/components/ui/ExportMenu";
import FilterBar from "@/components/ui/FilterBar";
import GeoScopeFilter from "@/components/reports/GeoScopeFilter";
import { CHECKBOX_LABEL_CLASS } from "@/components/ui/FormControls";
import LoadingState from "@/components/ui/LoadingState";
import DataTable, { DataTableState } from "@/components/data-table/DataTable";
import { ColumnDef, TrainingAvailableRow } from "@/types";
import { functionTypeLabel, safeExternalUrl, trainingTypeLabel } from "@/lib/utils";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";

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
      safeExternalUrl(row.link) ? (
        <a
          href={safeExternalUrl(row.link) ?? undefined}
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
  const [visibleRows, setVisibleRows] = useState<TrainingAvailableRow[]>([]);
  const [lastImport, setLastImport] = useState<string | null>(null);

  // Filters are mirrored to the URL so that navigating into a training and
  // back (router.back()) restores them.
  const theatre = searchParams.get("theatre") ?? "";
  const region = searchParams.get("region") ?? "";
  const country = searchParams.get("country") ?? "";
  const activeOnly = searchParams.get("active") === "true";

  // DataTable state is also mirrored to the URL: `q`/`qCol` for the global
  // search, `sort`/`sortDir` for column sort, and any `f_<columnKey>` keys
  // for per-column filters. These seed the table on mount; the table emits
  // changes via onStateChange below, which writes them back to the URL.
  const initialSearchTerm = searchParams.get("q") ?? "";
  const initialSearchColumn = searchParams.get("qCol") ?? "all";
  const initialSortColumn = searchParams.get("sort") ?? undefined;
  const initialSortDirRaw = searchParams.get("sortDir");
  const initialSortDirection: "asc" | "desc" | undefined =
    initialSortDirRaw === "asc" || initialSortDirRaw === "desc" ? initialSortDirRaw : undefined;
  const initialColumnFilters = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      if (key.startsWith("f_") && value) out[key.slice(2)] = value;
    });
    return out;
  }, [searchParams]);
  // initialColumnFilters is intentionally memoised on searchParams so that
  // identity changes only when the URL itself changes (not on every render).
  // Page/size are also mirrored so the page survives back-navigation.
  const initialPage = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const sizeParam = searchParams.get("size");
  const initialPageSize = sizeParam ? parseInt(sizeParam, 10) || undefined : undefined;

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

  // `loading` is derived by useFetchJson (loadedKey !== requestKey) rather than
  // written by a synchronous setState inside an effect; a null url parks the
  // hook in its loading state while the company scope resolves.
  const trainingUrl = (() => {
    if (scopeLoading) return null;
    const params = new URLSearchParams();
    if (theatre) params.set("theatre", theatre);
    if (region) params.set("region", region);
    if (country) params.set("country", country);
    if (activeOnly) params.set("active", "true");
    const qs = params.toString();
    return withCompany(`/api/training-data${qs ? `?${qs}` : ""}`, selected);
  })();
  const { data: trainingData, loading } = useFetchJson<TrainingAvailableRow[]>(trainingUrl);
  const training = useMemo(() => trainingData ?? [], [trainingData]);

  // Reset the visible-rows snapshot used by Export whenever a new dataset
  // lands. Done with React's "adjust state while rendering" pattern because
  // visibleRows is also written by DataTable's onStateChange, so it is seeded
  // here but owned by the table afterwards.
  const [prevTraining, setPrevTraining] = useState(training);
  if (prevTraining !== training) {
    setPrevTraining(training);
    setVisibleRows(training);
  }

  const handleTableStateChange = useCallback(
    (state: DataTableState, rows: TrainingAvailableRow[]) => {
      setVisibleRows(rows);
      const params = new URLSearchParams(searchParams.toString());
      // Clear any previously-set DataTable params so removed filters disappear
      // from the URL.
      params.delete("q");
      params.delete("qCol");
      params.delete("sort");
      params.delete("sortDir");
      params.delete("page");
      params.delete("size");
      for (const key of Array.from(params.keys())) {
        if (key.startsWith("f_")) params.delete(key);
      }
      if (state.searchTerm) params.set("q", state.searchTerm);
      if (state.searchColumn && state.searchColumn !== "all") params.set("qCol", state.searchColumn);
      if (state.sortColumn) {
        params.set("sort", state.sortColumn);
        params.set("sortDir", state.sortDirection);
      }
      for (const [key, value] of Object.entries(state.columnFilters)) {
        if (value) params.set(`f_${key}`, value);
      }
      if (state.page > 1) params.set("page", String(state.page));
      if (state.pageSize !== 50) params.set("size", String(state.pageSize));
      const qs = params.toString();
      const next = qs ? `${pathname}?${qs}` : pathname;
      // Avoid pushing identical URLs into history (router.replace would still
      // trigger a re-render and re-emit, causing a tight loop).
      const current = searchParams.toString();
      if (qs !== current) {
        router.replace(next, { scroll: false });
      }
    },
    [searchParams, pathname, router]
  );

  useEffect(() => {
    fetch("/api/import-metadata?key=training-data")
      .then((res) => res.json())
      .then((data) => {
        if (data?.timestamp) setLastImport(data.timestamp);
      })
      .catch(() => {});
  }, []);

  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  // Set of "fullTitle::trainingType" keys for fast intersection with the
  // student-join response. Encoded with raw trainingType to match the
  // `rawTrainingType` returned by the server.
  const visibleKeySet = useMemo(
    () => new Set(visibleRows.map((r) => `${r.fullTitle}::${r.trainingType}`)),
    [visibleRows]
  );

  const runExportWithStudents = useCallback(
    async (format: "csv" | "excel" | "pdf") => {
      setExportLoading(true);
      try {
        const params = new URLSearchParams();
        if (theatre) params.set("theatre", theatre);
        if (region) params.set("region", region);
        if (country) params.set("country", country);
        if (activeOnly) params.set("active", "true");
        const qs = params.toString();
        const base = `/api/training-data/with-students${qs ? `?${qs}` : ""}`;
        const res = await fetch(withCompany(base, selected));
        if (!res.ok) throw new Error(`Export request failed (${res.status})`);
        const allRows: Array<{
          fullName: string;
          email: string;
          theatre: string;
          region: string;
          country: string;
          trainingTitle: string;
          trainingType: string;
          rawTrainingType: string;
          productType: string;
          function: string;
          completedDate: string;
          expiryDate: string;
          active: string;
        }> = await res.json();

        const rows = allRows
          .filter((r) => visibleKeySet.has(`${r.trainingTitle}::${r.rawTrainingType}`))
          .map((r) => ({
            fullTitle: r.trainingTitle,
            trainingType: r.trainingType,
            productType: r.productType,
            function: r.function,
            fullName: r.fullName,
            email: r.email,
            theatre: r.theatre,
            region: r.region,
            country: r.country,
            completedDate: r.completedDate,
            expiryDate: r.expiryDate,
            active: r.active,
          }));

        const cols: { key: keyof (typeof rows)[0]; header: string }[] = [
          { key: "fullTitle", header: "Full Title" },
          { key: "trainingType", header: "Training Type" },
          { key: "productType", header: "Product Type" },
          { key: "function", header: "Function" },
          { key: "fullName", header: "Full Name" },
          { key: "email", header: "Email" },
          { key: "theatre", header: "Theatre" },
          { key: "region", header: "Region" },
          { key: "country", header: "Country" },
          { key: "completedDate", header: "Completed Date" },
          { key: "expiryDate", header: "Expiry Date" },
          { key: "active", header: "Active" },
        ];

        const filename = "training-with-students";
        if (format === "csv") exportToCsv(rows, cols, filename);
        else if (format === "excel") exportToExcel(rows, cols, filename);
        else exportToPdf(rows, cols, filename);
      } catch (err) {
        console.error(err);
        alert("Export failed. Please try again.");
      } finally {
        setExportLoading(false);
        setShowExportMenu(false);
      }
    },
    [theatre, region, country, activeOnly, selected, visibleKeySet]
  );

  const exportData = useMemo(
    () =>
      visibleRows.map((r) => ({
        fullTitle: r.fullTitle,
        trainingType: trainingTypeLabel(r.trainingType),
        productType: r.productType,
        function: functionTypeLabel(r.function),
        link: r.link ?? "",
        studentsTaken: r.studentsTaken,
      })),
    [visibleRows]
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
      <LoadingState label="Loading training catalogue…" />
    );
  }

  const hasFilters = !!(theatre || region || country || activeOnly);

  return (
    <div>
      <PageHeader
        title="Training"
        helpSlug="training"
        rightContent={
          <div className="flex items-center gap-3">
            {lastImport && (
              <span className="text-sm text-gray-500">
                Last imported: {new Date(lastImport).toLocaleString()}
              </span>
            )}
            {visibleRows.length > 0 && (
              <ExportMenu
                show={showExportMenu}
                setShow={setShowExportMenu}
                groups={[
                  {
                    label: "Catalogue",
                    onExport: (fmt) => {
                      if (fmt === "csv") exportToCsv(exportData, exportColumns, "training");
                      else if (fmt === "excel") exportToExcel(exportData, exportColumns, "training");
                      else exportToPdf(exportData, exportColumns, "training");
                    },
                  },
                  {
                    label: "Catalogue with students",
                    busy: exportLoading,
                    onExport: (fmt) => runExportWithStudents(fmt),
                  },
                ]}
              />
            )}
          </div>
        }
      />
      <FilterBar>
        <FilterBar.Row>
          <GeoScopeFilter
            value={{ theatre, region, country }}
            onChange={(next) =>
              // One atomic write: the cascade clears the descendants it
              // invalidates, where three independent selects left a stale
              // region or country in the URL after changing theatre.
              updateFilter({
                theatre: next.theatre || null,
                region: next.region || null,
                country: next.country || null,
              })
            }
          />
          <label className={CHECKBOX_LABEL_CLASS}>
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
        </FilterBar.Row>
      </FilterBar>

      <DataTable<TrainingAvailableRow>
        data={training}
        columns={columns}
        initialSearchTerm={initialSearchTerm}
        initialSearchColumn={initialSearchColumn}
        initialColumnFilters={initialColumnFilters}
        initialSortColumn={initialSortColumn}
        initialSortDirection={initialSortDirection}
        initialPage={initialPage}
        initialPageSize={initialPageSize}
        onStateChange={handleTableStateChange}
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
        <LoadingState label="Loading training catalogue…" />
      }
    >
      <TrainingPageInner />
    </Suspense>
  );
}
