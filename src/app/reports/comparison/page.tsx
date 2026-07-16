"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import DateRangePicker, { DateRangeValue } from "@/components/ui/DateRangePicker";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { useProductTypeColors } from "@/hooks/useProductTypeColors";
import { GroupByMode, GROUP_BY_LABEL } from "@/lib/group-by";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { ArrowLeft, Download, Users, GraduationCap, Map as MapIcon, AlertTriangle } from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

type RangePreset = "12m" | "6m" | "3m" | "all" | "custom";

const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: "12m", label: "Last 12 months" },
  { value: "6m", label: "Last 6 months" },
  { value: "3m", label: "Last 3 months" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom range" },
];

type CompareMode = "type" | "function" | "product" | "time";

const COMPARE_MODES: { value: CompareMode; label: string }[] = [
  { value: "type", label: "By Training Type" },
  { value: "function", label: "By Function" },
  { value: "product", label: "By Product" },
  { value: "time", label: "Over Time" },
];

type SortKey =
  | "bucket" | "headcount" | "cert" | "accred" | "ilt" | "olx"
  | "total" | "perStudent" | "exp3" | "exp6";

interface BucketMetrics {
  bucket: string;
  headcount: number;
  cert: number;
  accred: number;
  ilt: number;
  olx: number;
  total: number;
  perStudent: number;
  exp3: number;
  exp6: number;
}

interface ComparisonResponse {
  metrics: BucketMetrics[];
  totals: { headcount: number; cert: number; accred: number; ilt: number; olx: number; total: number; exp3: number; exp6: number };
  chart: { mode: CompareMode; rows: Record<string, string | number>[]; series: string[] };
  filterOptions: { functions: string[]; products: string[]; types: string[] };
}

function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ExportMenu({ onExport, busy }: { onExport: (fmt: "csv" | "excel" | "pdf") => void; busy: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setShow((p) => !p)} disabled={busy} className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300 disabled:opacity-50">
        <Download size={16} /> {busy ? "Exporting…" : "Export"}
      </button>
      {show && !busy && (
        <div className="absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
          <button onClick={() => { onExport("csv"); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg">Export as CSV</button>
          <button onClick={() => { onExport("excel"); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100">Export as Excel</button>
          <button onClick={() => { onExport("pdf"); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg">Export as PDF</button>
        </div>
      )}
    </div>
  );
}

export default function ComparisonPage() {
  const chart = useChartTheme();
  const productColors = useProductTypeColors();
  const companyScope = useCompanyScope();

  const [geoMode, setGeoMode] = useState<GroupByMode>("theatre");
  const [rangePreset, setRangePreset] = useState<RangePreset>("12m");
  const [customRange, setCustomRange] = useState<DateRangeValue>({ from: null, to: null });
  const [filterFunction, setFilterFunction] = useState("");
  const [filterProduct, setFilterProduct] = useState("");
  const [filterType, setFilterType] = useState("");
  const [compareMode, setCompareMode] = useState<CompareMode>("type");
  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set("geoMode", geoMode);
    params.set("range", rangePreset);
    if (rangePreset === "custom") {
      if (customRange.from) params.set("from", localYmd(customRange.from));
      if (customRange.to) params.set("to", localYmd(customRange.to));
    }
    if (filterFunction) params.set("func", filterFunction);
    if (filterProduct) params.set("product", filterProduct);
    if (filterType) params.set("type", filterType);
    params.set("compareMode", compareMode);
    return params;
  }, [geoMode, rangePreset, customRange, filterFunction, filterProduct, filterType, compareMode]);

  // Loading is derived (loaded.key !== requestKey), not set synchronously in the
  // effect, so a control change re-shows the spinner without a
  // set-state-in-effect violation. Stale data is kept until the new fetch lands.
  const query = buildParams().toString();
  const requestKey = companyScope.loading ? "__disabled__" : `${query}|sel:${companyScope.selected}`;
  const [loaded, setLoaded] = useState<{ key: string; data: ComparisonResponse | null }>({ key: "__init__", data: null });
  const loading = loaded.key !== requestKey;
  const data = loaded.data;

  useEffect(() => {
    if (companyScope.loading) return;
    const url = withCompany(`/api/reports/comparison?${query}`, companyScope.selected);
    let cancelled = false;
    fetch(url)
      .then((r) => r.json())
      .then((d: ComparisonResponse) => {
        if (!cancelled) setLoaded({ key: requestKey, data: d });
      })
      .catch(() => {
        if (!cancelled) setLoaded((prev) => ({ ...prev, key: requestKey }));
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, query, companyScope.loading, companyScope.selected]);

  const metrics = useMemo(() => data?.metrics ?? [], [data]);
  const totals = data?.totals ?? { headcount: 0, cert: 0, accred: 0, ilt: 0, olx: 0, total: 0, exp3: 0, exp6: 0 };
  const chartData = data?.chart ?? { mode: "type" as CompareMode, rows: [], series: [] };
  const functions = data?.filterOptions.functions ?? [];
  const products = data?.filterOptions.products ?? [];
  const types = data?.filterOptions.types ?? [];

  const sortedMetrics = useMemo(() => {
    const arr = [...metrics];
    arr.sort((a, b) => {
      if (sortKey === "bucket") {
        return sortDir === "asc" ? a.bucket.localeCompare(b.bucket) : b.bucket.localeCompare(a.bucket);
      }
      const av = a[sortKey] as number;
      const bv = b[sortKey] as number;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [metrics, sortKey, sortDir]);

  const geoLabel = GROUP_BY_LABEL[geoMode];

  const exportColumns = [
    { key: "bucket", header: geoLabel },
    { key: "headcount", header: "Headcount" },
    { key: "cert", header: "Certifications" },
    { key: "accred", header: "Accreditations" },
    { key: "ilt", header: "ILTs" },
    { key: "olx", header: "OLX" },
    { key: "total", header: "Total" },
    { key: "perStudent", header: "Trainings/Student" },
    { key: "exp3", header: "Expiring 3mo" },
    { key: "exp6", header: "Expiring 6mo" },
  ];

  const handleExport = (fmt: "csv" | "excel" | "pdf") => {
    const exportRows = sortedMetrics.map((r) => ({ ...r, perStudent: r.perStudent.toFixed(1) }));
    const filename = `comparison-by-${geoMode}`;
    if (fmt === "csv") exportToCsv(exportRows as never, exportColumns as never, filename);
    else if (fmt === "excel") exportToExcel(exportRows as never, exportColumns as never, filename);
    else exportToPdf(exportRows as never, exportColumns as never, filename);
  };

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "bucket" ? "asc" : "desc");
    }
  }
  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");
  const numHeader = (key: SortKey, label: string) => (
    <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none whitespace-nowrap" onClick={() => toggleSort(key)}>
      {label}{sortIndicator(key)}
    </th>
  );

  if (loading && !data) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>;
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Reports
        </Link>
      </div>
      <PageHeader title="Theatre / Region / Country Comparison" helpSlug="reports" />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <span className="text-sm font-medium text-gray-700">Compare by:</span>
        <select value={geoMode} onChange={(e) => setGeoMode(e.target.value as GroupByMode)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
          <option value="theatre">Theatre</option>
          <option value="region">Region</option>
          <option value="country">Country</option>
        </select>
        <select value={rangePreset} onChange={(e) => setRangePreset(e.target.value as RangePreset)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
          {RANGE_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        {rangePreset === "custom" && (
          <DateRangePicker value={customRange} onChange={setCustomRange} placeholder="Pick a date range" align="start" />
        )}
        <select value={filterFunction} onChange={(e) => setFilterFunction(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="">All Functions</option>
          {functions.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="">All Products</option>
          {products.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="">All Types</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <KpiStrip
        cards={[
          { label: "Total Students", value: totals.headcount, icon: Users, tone: "blue" },
          { label: "Total Trainings", value: totals.total, icon: GraduationCap, tone: "indigo" },
          { label: `${geoLabel}s Compared`, value: metrics.length, icon: MapIcon, tone: "emerald" },
          { label: "Expiring in 6 Months", value: totals.exp6, icon: AlertTriangle, tone: "amber" },
        ]}
      />

      <section className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="text-base font-semibold text-gray-900">{geoLabel} Comparison — {COMPARE_MODES.find((m) => m.value === compareMode)?.label}</h3>
          <select value={compareMode} onChange={(e) => setCompareMode(e.target.value as CompareMode)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
            {COMPARE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <ResponsiveContainer width="100%" height={340}>
          {chartData.mode === "time" ? (
            <LineChart data={chartData.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              {chartData.series.map((s, i) => (
                <Line key={s} type="monotone" dataKey={s} stroke={chart.series(i)} strokeWidth={2} dot={{ r: 2 }} />
              ))}
            </LineChart>
          ) : (
            <BarChart data={chartData.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={60} interval={0} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              {chartData.series.map((s, i) => (
                <Bar
                  key={s}
                  dataKey={s}
                  fill={compareMode === "product" ? chart.productColor(s, productColors) : chart.series(i)}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
        {chartData.mode === "time" && chartData.series.length === 8 && (
          <p className="text-xs text-gray-400 mt-2">Showing the top 8 {geoLabel.toLowerCase()}s by total completions.</p>
        )}
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">Counts reflect the selected time range and filters; expiring counts look forward from today.</p>
          <ExportMenu onExport={handleExport} busy={false} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("bucket")}>{geoLabel}{sortIndicator("bucket")}</th>
                {numHeader("headcount", "Headcount")}
                {numHeader("cert", "Certs")}
                {numHeader("accred", "Accreds")}
                {numHeader("ilt", "ILTs")}
                {numHeader("olx", "OLX")}
                {numHeader("total", "Total")}
                {numHeader("perStudent", "Per Student")}
                {numHeader("exp3", "Exp 3mo")}
                {numHeader("exp6", "Exp 6mo")}
              </tr>
            </thead>
            <tbody>
              {sortedMetrics.map((r) => (
                <tr key={r.bucket} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{r.bucket}</td>
                  <td className="px-4 py-3 text-right">{r.headcount.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{r.cert.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{r.accred.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{r.ilt.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{r.olx.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-semibold">{r.total.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{r.headcount > 0 ? r.perStudent.toFixed(1) : "—"}</td>
                  <td className="px-4 py-3 text-right">{r.exp3.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{r.exp6.toLocaleString()}</td>
                </tr>
              ))}
              {sortedMetrics.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-gray-500">No data for the selected filters.</td></tr>
              )}
            </tbody>
            {sortedMetrics.length > 0 && (
              <tfoot>
                <tr className="bg-gray-50 border-t font-semibold">
                  <td className="px-4 py-3">Total</td>
                  <td className="px-4 py-3 text-right">{totals.headcount.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{totals.cert.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{totals.accred.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{totals.ilt.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{totals.olx.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{totals.total.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{totals.headcount > 0 ? (totals.total / totals.headcount).toFixed(1) : "—"}</td>
                  <td className="px-4 py-3 text-right">{totals.exp3.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{totals.exp6.toLocaleString()}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
