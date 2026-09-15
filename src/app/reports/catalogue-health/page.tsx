"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { useProductTypeColors } from "@/hooks/useProductTypeColors";
import { useTableSort, SortAccessor } from "@/hooks/useTableSort";
import { exportToCsv, exportToExcel } from "@/lib/export";
import { exportReportTablePdf } from "@/lib/report-export";
import ExportMenu, { type ExportFormat } from "@/components/ui/ExportMenu";
import { ExportableChart, useChartCapture } from "@/components/reports/ChartCaptureProvider";
import { TitleYAxisTick } from "@/components/reports/ChartTicks";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useFetchJson } from "@/hooks/useFetchJson";
import { ArrowLeft, BookOpen, AlertOctagon, AlertTriangle, TrendingDown } from "lucide-react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface CatalogueRow {
  fullTitle: string;
  productType: string;
  trainingType: string;
  function: string;
  totalCompletions: number;
  last12mo: number;
  activeStudents: number;
  expiring90d: number;
  uptakePct: number;
  zeroUptake: boolean;
}

/** The status filter's own options — a value outside this set has no control to render. */
const STATUS_OPTIONS = ["all", "zero", "expiring"] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number];

function parseStatus(v: string | null): StatusFilter {
  return (STATUS_OPTIONS as readonly string[]).includes(v ?? "") ? (v as StatusFilter) : "all";
}

function CatalogueHealthPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const chart = useChartTheme();
  const productColors = useProductTypeColors();
  const companyScope = useCompanyScope();
  const { data: catalogueData, loading } = useFetchJson<{ rows?: CatalogueRow[] }>(
    withCompany("/api/reports/catalogue-health", companyScope.selected),
    { enabled: !companyScope.loading }
  );
  const rows = useMemo(() => catalogueData?.rows ?? [], [catalogueData]);
  // Seeded from the URL so a reload or a shared link reopens the same view.
  const [filterProduct, setFilterProduct] = useState(() => searchParams.get("product") ?? "");
  const [filterType, setFilterType] = useState(() => searchParams.get("type") ?? "");
  const [filterStatus, setFilterStatus] = useState<StatusFilter>(() => parseStatus(searchParams.get("status")));

  // Mount-time snapshot of the sort the URL asked for. `useTableSort` seeds its
  // internal state from `defaultKey`/`defaultDir`, so this is read once; holding
  // it in state keeps the mirror effect's rewrites from feeding back in.
  const [urlSort] = useState(() => ({
    key: searchParams.get("sort") ?? "",
    dir: searchParams.get("sortDir") === "desc" ? ("desc" as const) : ("asc" as const),
  }));

  const products = useMemo(() => [...new Set(rows.map((r) => r.productType))].sort(), [rows]);
  const types = useMemo(() => [...new Set(rows.map((r) => r.trainingType))].sort(), [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (filterProduct && r.productType !== filterProduct) return false;
    if (filterType && r.trainingType !== filterType) return false;
    if (filterStatus === "zero" && !r.zeroUptake) return false;
    if (filterStatus === "expiring" && r.expiring90d === 0) return false;
    return true;
  }), [rows, filterProduct, filterType, filterStatus]);

  const kpis = useMemo(() => ({
    totalTitles: rows.length,
    zeroUptake: rows.filter((r) => r.zeroUptake).length,
    expiring90d: rows.filter((r) => r.expiring90d > 0).length,
    decliningLast12: rows.filter((r) => r.totalCompletions > 0 && r.last12mo === 0).length,
  }), [rows]);

  // Column sorting for the detail table (numeric columns default to highest-first).
  const sortAccessors: Record<string, SortAccessor<CatalogueRow>> = {
    fullTitle: (r) => r.fullTitle,
    productType: (r) => r.productType,
    trainingType: (r) => r.trainingType,
    function: (r) => r.function,
    totalCompletions: (r) => r.totalCompletions,
    last12mo: (r) => r.last12mo,
    activeStudents: (r) => r.activeStudents,
    expiring90d: (r) => r.expiring90d,
    uptakePct: (r) => r.uptakePct,
  };
  const { sorted, sortKey, sortDir, toggleSort, sortIndicator } = useTableSort(filtered, sortAccessors, {
    // A seeded key that names no column would leave the table silently unsorted
    // (useTableSort returns the rows untouched), so check it against the map.
    // `Object.hasOwn`, not `in`: `?sort=constructor` satisfies `in` via the
    // prototype and would hand the sorter the Object constructor as an accessor.
    defaultKey: Object.hasOwn(sortAccessors, urlSort.key) ? urlSort.key : "fullTitle",
    defaultDir: urlSort.dir,
    tiebreakKey: "fullTitle",
    descFirstKeys: ["totalCompletions", "last12mo", "activeStudents", "expiring90d", "uptakePct"],
  });

  // Mirror the view to the URL so a reload, a bookmark or Back restores it.
  const buildViewParams = useCallback(() => {
    const params = new URLSearchParams();
    if (filterProduct) params.set("product", filterProduct);
    if (filterType) params.set("type", filterType);
    if (filterStatus !== "all") params.set("status", filterStatus);
    params.set("sort", sortKey);
    params.set("sortDir", sortDir);
    return params;
  }, [filterProduct, filterType, filterStatus, sortKey, sortDir]);

  useEffect(() => {
    const qs = buildViewParams().toString();
    if (qs !== searchParams.toString()) {
      router.replace(`${pathname}?${qs}`, { scroll: false });
    }
  }, [buildViewParams, pathname, router, searchParams]);

  const topUptake = useMemo(() => filtered.slice().sort((a, b) => b.activeStudents - a.activeStudents).slice(0, 10), [filtered]);
  const topExpiring = useMemo(() => filtered.slice().filter((r) => r.expiring90d > 0).sort((a, b) => b.expiring90d - a.expiring90d).slice(0, 10), [filtered]);

  const { capturePageVisuals } = useChartCapture();
  const [exporting, setExporting] = useState(false);

  const exportColumns = [
    { key: "fullTitle", header: "Training" },
    { key: "productType", header: "Product" },
    { key: "trainingType", header: "Type" },
    { key: "function", header: "Function" },
    { key: "totalCompletions", header: "Total Completions" },
    { key: "last12mo", header: "Last 12 Months" },
    { key: "activeStudents", header: "Active Students" },
    { key: "expiring90d", header: "Expiring (90d)" },
    { key: "uptakePct", header: "Uptake %" },
    { key: "zeroUptake", header: "Zero Uptake" },
  ];
  const exportRows = filtered.map((r) => ({ ...r, uptakePct: r.uptakePct.toFixed(1), zeroUptake: r.zeroUptake ? "Yes" : "No" }));

  const handleExport = async (fmt: ExportFormat, { includeCharts }: { includeCharts: boolean }) => {
    if (fmt === "csv") return exportToCsv(exportRows as never, exportColumns as never, "catalogue-health");
    if (fmt === "excel") return exportToExcel(exportRows as never, exportColumns as never, "catalogue-health");
    setExporting(true);
    try {
      exportReportTablePdf({
        title: "Training Catalogue Health",
        filename: "catalogue-health",
        columns: exportColumns,
        rows: exportRows as never,
        // Charts and the KPI strip travel together: one tickbox governs both.
        ...(includeCharts ? await capturePageVisuals() : {}),
      });
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>;
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Reports
        </Link>
      </div>
      <PageHeader title="Training Catalogue Health" helpSlug="reports-catalogue-health" />

      <KpiStrip
        cards={[
          { label: "Catalogue Titles", value: kpis.totalTitles, icon: BookOpen, tone: "blue" },
          { label: "Zero Completions", value: kpis.zeroUptake, icon: AlertOctagon, tone: "red" },
          { label: "Titles w/ 90d Expiries", value: kpis.expiring90d, icon: AlertTriangle, tone: "amber" },
          { label: "Stale (no 12m completions)", value: kpis.decliningLast12, icon: TrendingDown, tone: "indigo" },
        ]}
      />

      <section className="grid grid-cols-1 gap-6 mb-6">
        <ExportableChart className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Top 10 by Active Students</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topUptake} layout="vertical" margin={{ left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis type="category" dataKey="fullTitle" tick={<TitleYAxisTick fill={chart.axis} />} interval={0} stroke={chart.axis} width={300} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Bar dataKey="activeStudents">
                {topUptake.map((r) => (
                  <Cell key={r.fullTitle} fill={chart.productColor(r.productType, productColors)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ExportableChart>
        <ExportableChart className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Mass-Expiry Risk (90 days)</h3>
          {topExpiring.length === 0 ? (
            <div className="text-sm text-gray-500 py-8 text-center">No titles with active records expiring in the next 90 days.</div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={topExpiring} layout="vertical" margin={{ left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
                <YAxis type="category" dataKey="fullTitle" tick={<TitleYAxisTick fill={chart.axis} />} interval={0} stroke={chart.axis} width={300} />
                <Tooltip contentStyle={tooltipStyle(chart)} />
                <Bar dataKey="expiring90d">
                  {topExpiring.map((r) => (
                    <Cell key={r.fullTitle} fill={chart.productColor(r.productType, productColors)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ExportableChart>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">Per-training catalogue uptake, completions, and expiry pressure</p>
          <span className="text-sm font-medium text-gray-500">{filtered.length} title{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-wrap gap-3 mb-4">
            <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">All Products</option>
              {products.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">All Types</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as StatusFilter)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="all">All Titles</option>
              <option value="zero">Zero Completions Only</option>
              <option value="expiring">With 90-day Expiries</option>
            </select>
            <ExportMenu onExport={handleExport} busy={exporting} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("fullTitle")}>Training{sortIndicator("fullTitle")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("productType")}>Product{sortIndicator("productType")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("trainingType")}>Type{sortIndicator("trainingType")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("function")}>Function{sortIndicator("function")}</th>
                  <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none" onClick={() => toggleSort("totalCompletions")}>Total{sortIndicator("totalCompletions")}</th>
                  <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none" onClick={() => toggleSort("last12mo")}>Last 12mo{sortIndicator("last12mo")}</th>
                  <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none" onClick={() => toggleSort("activeStudents")}>Active{sortIndicator("activeStudents")}</th>
                  <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none" onClick={() => toggleSort("expiring90d")}>Expiring 90d{sortIndicator("expiring90d")}</th>
                  <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none" onClick={() => toggleSort("uptakePct")}>Uptake{sortIndicator("uptakePct")}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={`${r.fullTitle}-${i}`} className={`border-b hover:bg-gray-50 ${r.zeroUptake ? "bg-red-50" : ""}`}>
                    <td className="px-4 py-3">{r.fullTitle}</td>
                    <td className="px-4 py-3">{r.productType}</td>
                    <td className="px-4 py-3">{r.trainingType}</td>
                    <td className="px-4 py-3">{r.function}</td>
                    <td className="px-4 py-3 text-right">{r.totalCompletions}</td>
                    <td className="px-4 py-3 text-right">{r.last12mo}</td>
                    <td className="px-4 py-3 text-right">{r.activeStudents}</td>
                    <td className="px-4 py-3 text-right">{r.expiring90d}</td>
                    <td className="px-4 py-3 text-right">{r.uptakePct.toFixed(1)}%</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-500">No titles match the current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CatalogueHealthPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>}>
      <CatalogueHealthPageInner />
    </Suspense>
  );
}
