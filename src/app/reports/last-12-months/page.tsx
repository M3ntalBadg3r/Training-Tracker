"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import DateRangePicker, { DateRangeValue } from "@/components/ui/DateRangePicker";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { useProductTypeColors } from "@/hooks/useProductTypeColors";
import { resolveBucket, GROUP_BY_LABEL, GroupByMode } from "@/lib/group-by";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useDebounce } from "@/hooks/useDebounce";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import GeoScopeFilter, { GeoScope } from "@/components/reports/GeoScopeFilter";
import { Search, Download, ArrowLeft, Award, ShieldCheck, GraduationCap, TrendingUp } from "lucide-react";
import Pagination from "@/components/data-table/Pagination";
import {
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Line,
  ComposedChart,
} from "recharts";

interface TrainingRecordRow {
  fullName: string;
  email: string;
  theatre: string;
  region: string;
  country: string;
  trainingTitle: string;
  trainingType: string;
  productType: string;
  function: string;
  completedDate: string;
  expiryDate: string;
  active: boolean;
}

type Granularity = "day" | "week" | "month";
type RangePreset = "12m" | "6m" | "3m" | "1m" | "custom";

interface AchievementResponse {
  charts: {
    chartData: { bucketKey: string; label: string; "This period": number; "Prior period": number }[];
    topTitles: { title: string; count: number; productType: string }[];
    granularity: Granularity;
  };
  kpis: { total: number; cert: number; accred: number; ilt: number; olx: number; thisPeriodTotal: number; priorPeriodTotal: number; change: number };
  groups: { key: string; total: number }[];
  rows: TrainingRecordRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: { types: string[]; functions: string[]; products: string[] };
}

const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: "12m", label: "Last 12 months" },
  { value: "6m", label: "Last 6 months" },
  { value: "3m", label: "Last 3 months" },
  { value: "1m", label: "Last 1 month" },
  { value: "custom", label: "Custom range" },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

function typeBadgeClass(t: string): string {
  if (t === "Certification") return "bg-blue-100 text-blue-800";
  if (t === "Accreditation") return "bg-emerald-100 text-emerald-800";
  if (t === "OLX") return "bg-sky-100 text-sky-800";
  return "bg-amber-100 text-amber-800";
}

const exportColumns = [
  { key: "fullName", header: "Full Name" },
  { key: "email", header: "Email" },
  { key: "theatre", header: "Theatre" },
  { key: "region", header: "Region" },
  { key: "country", header: "Country" },
  { key: "trainingTitle", header: "Training" },
  { key: "trainingType", header: "Training Type" },
  { key: "productType", header: "Product Type" },
  { key: "function", header: "Function" },
  { key: "completedDate", header: "Completed Date" },
  { key: "expiryDate", header: "Expiry Date" },
  { key: "active", header: "Active" },
];

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

function parseGroupBy(v: string | null, fallback: GroupByMode | null): GroupByMode | null {
  if (v === "none") return null;
  if (v === "theatre" || v === "region" || v === "country") return v;
  return fallback;
}

function parseRange(v: string | null): RangePreset {
  if (v === "12m" || v === "6m" || v === "3m" || v === "1m" || v === "custom") return v;
  return "12m";
}

function AchievementOverTimePageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const chart = useChartTheme();
  const productColors = useProductTypeColors();
  const { formatDate } = useDateFormat();
  const companyScope = useCompanyScope();

  // Seed from the URL so Back from a record restores filters + page (mirrored
  // back by the effect below).
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const debouncedSearch = useDebounce(search, 300);
  const [filterType, setFilterType] = useState(() => searchParams.get("type") ?? "");
  const [geo, setGeo] = useState<GeoScope>(() => ({
    theatre: searchParams.get("theatre") ?? "",
    region: searchParams.get("region") ?? "",
    country: searchParams.get("country") ?? "",
  }));
  const [filterFunction, setFilterFunction] = useState(() => searchParams.get("function") ?? "");
  const [filterProduct, setFilterProduct] = useState(() => searchParams.get("product") ?? "");
  const [filterBucket, setFilterBucket] = useState<string | null>(() => searchParams.get("bucket"));
  const [groupBy, setGroupBy] = useState<GroupByMode | null>(() => parseGroupBy(searchParams.get("groupBy"), null));
  const [rangePreset, setRangePreset] = useState<RangePreset>(() => parseRange(searchParams.get("range")));
  const [customRange, setCustomRange] = useState<DateRangeValue>(() => ({
    from: searchParams.get("customFrom") ? new Date(searchParams.get("customFrom")!) : null,
    to: searchParams.get("customTo") ? new Date(searchParams.get("customTo")!) : null,
  }));
  const [sortColumn, setSortColumn] = useState(() => searchParams.get("sort") ?? "fullName");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => (searchParams.get("sortDir") === "desc" ? "desc" : "asc"));
  const [page, setPage] = useState(() => Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1));
  const [pageSize, setPageSize] = useState(() => parseInt(searchParams.get("pageSize") ?? "25", 10) || 25);

  const [data, setData] = useState<AchievementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const customFrom = customRange.from ? customRange.from.toISOString() : "";
  const customTo = customRange.to ? customRange.to.toISOString() : "";

  const buildParams = useCallback(
    (opts: { all?: boolean }) => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (filterType) params.set("type", filterType);
      if (geo.theatre) params.set("theatre", geo.theatre);
      if (geo.region) params.set("region", geo.region);
      if (geo.country) params.set("country", geo.country);
      if (filterFunction) params.set("function", filterFunction);
      if (filterProduct) params.set("product", filterProduct);
      if (filterBucket) params.set("bucket", filterBucket);
      params.set("range", rangePreset);
      if (rangePreset === "custom") {
        if (customFrom) params.set("customFrom", customFrom);
        if (customTo) params.set("customTo", customTo);
      }
      if (groupBy) params.set("groupBy", groupBy);
      params.set("sort", sortColumn);
      params.set("sortDir", sortDir);
      if (opts.all) params.set("all", "true");
      else {
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));
      }
      return params;
    },
    [debouncedSearch, filterType, geo, filterFunction, filterProduct, filterBucket, rangePreset, customFrom, customTo, groupBy, sortColumn, sortDir, page, pageSize]
  );

  // Reset to page 1 on filter/sort/scope change — but not on initial mount, so a
  // URL-seeded page survives back-navigation.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setPage(1);
  }, [debouncedSearch, filterType, geo, filterFunction, filterProduct, filterBucket, rangePreset, customFrom, customTo, groupBy, sortColumn, sortDir, companyScope.selected]);

  // Mirror view state to the URL (raw search wins over debounced) so Back
  // restores filters + page.
  useEffect(() => {
    const params = buildParams({});
    if (search) params.set("q", search);
    else params.delete("q");
    const qs = params.toString();
    const next = qs ? `${pathname}?${qs}` : pathname;
    if (qs !== searchParams.toString()) {
      router.replace(next, { scroll: false });
    }
  }, [buildParams, search, pathname, router, searchParams]);

  useEffect(() => {
    if (companyScope.loading) return;
    const url = withCompany(`/api/reports/last-12-months?${buildParams({}).toString()}`, companyScope.selected);
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then((r) => r.json())
      .then((d: AchievementResponse) => {
        if (!cancelled) setData(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [buildParams, companyScope.loading, companyScope.selected]);

  const chartData = data?.charts.chartData ?? [];
  const topTitles = data?.charts.topTitles ?? [];
  const granularity = data?.charts.granularity ?? "month";
  const kpis = data?.kpis ?? { total: 0, cert: 0, accred: 0, ilt: 0, olx: 0, thisPeriodTotal: 0, priorPeriodTotal: 0, change: 0 };
  const rows = data?.rows ?? [];
  const groups = data?.groups ?? [];
  const total = data?.total ?? 0;
  const types = data?.filterOptions.types ?? [];
  const functions = data?.filterOptions.functions ?? [];
  const products = data?.filterOptions.products ?? [];

  const granularityLabel = granularity === "day" ? "Daily" : granularity === "week" ? "Weekly" : "Monthly";
  const bucketLabel = granularity === "day" ? "day" : granularity === "week" ? "week" : "month";

  const toggleSort = (key: string) => {
    if (key === sortColumn) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(key);
      setSortDir("asc");
    }
  };
  const sortIndicator = (key: string) => (sortColumn === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  const handleExport = async (fmt: "csv" | "excel" | "pdf") => {
    setExporting(true);
    try {
      const url = withCompany(`/api/reports/last-12-months?${buildParams({ all: true }).toString()}`, companyScope.selected);
      const res = await fetch(url);
      const d: AchievementResponse = await res.json();
      const exportRows = d.rows.map((r) => ({
        ...r,
        completedDate: formatDate(r.completedDate),
        expiryDate: formatDate(r.expiryDate),
        active: r.active ? "Yes" : "No",
      }));
      if (fmt === "csv") exportToCsv(exportRows as never, exportColumns as never, "achievement-over-time");
      else if (fmt === "excel") exportToExcel(exportRows as never, exportColumns as never, "achievement-over-time");
      else exportToPdf(exportRows as never, exportColumns as never, "achievement-over-time");
    } finally {
      setExporting(false);
    }
  };

  if (loading && !data) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>;
  }

  const renderRow = (row: TrainingRecordRow, idx: number) => (
    <tr key={`${row.email}-${row.trainingTitle}-${idx}`} className="border-b hover:bg-gray-50">
      <td className="px-4 py-3">{row.fullName}</td>
      <td className="px-4 py-3">{row.email}</td>
      <td className="px-4 py-3">{row.theatre || "-"}</td>
      <td className="px-4 py-3">{row.region || "-"}</td>
      <td className="px-4 py-3">{row.country || "-"}</td>
      <td className="px-4 py-3">{row.trainingTitle}</td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${typeBadgeClass(row.trainingType)}`}>
          {row.trainingType}
        </span>
      </td>
      <td className="px-4 py-3">{row.productType}</td>
      <td className="px-4 py-3">{row.function}</td>
      <td className="px-4 py-3">{formatDate(row.completedDate)}</td>
      <td className="px-4 py-3">{formatDate(row.expiryDate)}</td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${row.active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
          {row.active ? "Yes" : "No"}
        </span>
      </td>
      <td className="px-4 py-3">
        <button onClick={() => router.push(`/students/${encodeURIComponent(row.email)}`)} className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors">View</button>
      </td>
    </tr>
  );

  const renderBody = () => {
    if (rows.length === 0) {
      return (
        <tbody>
          <tr>
            <td colSpan={13} className="px-4 py-8 text-center text-gray-500">No records found in the selected range.</td>
          </tr>
        </tbody>
      );
    }
    if (!groupBy) {
      return <tbody>{rows.map((row, idx) => renderRow(row, idx))}</tbody>;
    }
    const totals = new Map(groups.map((g) => [g.key, g.total]));
    const groupLabel = GROUP_BY_LABEL[groupBy];
    const items: React.ReactNode[] = [];
    let prevKey: string | null = null;
    const subtotal = (key: string) => {
      const n = totals.get(key) ?? 0;
      items.push(
        <tr key={`s-${key}`} className="bg-gray-50 border-b font-medium text-xs text-gray-600">
          <td colSpan={13} className="px-4 py-2">Subtotal — {n} record{n !== 1 ? "s" : ""}</td>
        </tr>
      );
    };
    rows.forEach((row, idx) => {
      const key = resolveBucket(row, groupBy);
      if (key !== prevKey) {
        if (prevKey !== null) subtotal(prevKey);
        const n = totals.get(key) ?? 0;
        items.push(
          <tr key={`h-${key}`} className="bg-gray-100 border-b">
            <td colSpan={13} className="px-4 py-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                <span>{groupLabel}: {key}</span>
                <span className="ml-auto text-xs font-normal text-gray-500">{n} record{n !== 1 ? "s" : ""}</span>
              </div>
            </td>
          </tr>
        );
        prevKey = key;
      }
      items.push(renderRow(row, idx));
    });
    if (prevKey !== null) subtotal(prevKey);
    return <tbody>{items}</tbody>;
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Reports
        </Link>
      </div>
      <PageHeader title="Achievement Over Time" helpSlug="reports" />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <span className="text-sm font-medium text-gray-700">Time range:</span>
        <select
          value={rangePreset}
          onChange={(e) => {
            setRangePreset(e.target.value as RangePreset);
            setFilterBucket(null);
          }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
        >
          {RANGE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        {rangePreset === "custom" && (
          <DateRangePicker
            value={customRange}
            onChange={(v) => {
              setCustomRange(v);
              setFilterBucket(null);
            }}
            placeholder="Pick a date range"
            align="start"
          />
        )}
      </div>

      <KpiStrip
        cards={[
          { label: "This Period", value: kpis.thisPeriodTotal, icon: TrendingUp, tone: "blue", hint: `${kpis.change >= 0 ? "+" : ""}${kpis.change.toFixed(1)}% vs prior` },
          { label: "Certifications", value: kpis.cert, icon: Award, tone: "indigo" },
          { label: "Accreditations", value: kpis.accred, icon: ShieldCheck, tone: "emerald" },
          { label: "ILTs", value: kpis.ilt, icon: GraduationCap, tone: "amber" },
          { label: "OLX", value: kpis.olx, icon: GraduationCap, tone: "blue" },
        ]}
      />

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="lg:col-span-2 bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">{granularityLabel} Completions vs Prior Period</h3>
            {filterBucket && (
              <button onClick={() => setFilterBucket(null)} className="text-xs text-blue-600 hover:underline">Clear {bucketLabel} filter</button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart
              data={chartData}
              style={{ cursor: "pointer" }}
              onClick={((state: unknown) => {
                // recharts v3 returns activeIndex as a string (see
                // combineActiveTooltipIndex.js → `return String(clampedIndex)`),
                // even though the .d.ts says number | TooltipIndex | undefined.
                const raw = (state as { activeIndex?: unknown })?.activeIndex;
                const idx =
                  typeof raw === "number"
                    ? raw
                    : typeof raw === "string" && raw !== ""
                      ? Number(raw)
                      : NaN;
                if (Number.isFinite(idx) && chartData[idx]) {
                  setFilterBucket(chartData[idx].bucketKey);
                }
              }) as never}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Area
                type="monotone"
                dataKey="This period"
                fill={chart.typeColor("Certification")}
                stroke={chart.typeColor("Certification")}
                fillOpacity={0.3}
              />
              <Line
                type="monotone"
                dataKey="Prior period"
                stroke={chart.axis}
                strokeDasharray="4 4"
                strokeWidth={2}
                dot={{ r: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-400 mt-2">Click a point to filter the table to that {bucketLabel}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Top 10 Trainings</h3>
          <div className="space-y-2">
            {topTitles.map((t, i) => {
              const max = topTitles[0]?.count ?? 1;
              const pct = (t.count / max) * 100;
              const color = chart.productColor(t.productType, productColors);
              return (
                <div key={t.title}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-700 truncate pr-2">{i + 1}. {t.title}</span>
                    <span className="text-gray-500 font-medium">{t.count}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded">
                    <div className="h-2 rounded" style={{ width: `${pct}%`, backgroundColor: color }} />
                  </div>
                </div>
              );
            })}
            {topTitles.length === 0 && <div className="text-sm text-gray-500">No completions in window.</div>}
          </div>
        </div>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">Training records completed in the selected range</p>
          <span className="text-sm font-medium text-gray-500">{total} result{total !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
              </div>
              <ExportMenu onExport={handleExport} busy={exporting} />
            </div>
            <div className="flex flex-wrap gap-3">
              <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Types</option>
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <GeoScopeFilter value={geo} onChange={setGeo} selectClassName="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" />
              <select value={filterFunction} onChange={(e) => setFilterFunction(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Functions</option>
                {functions.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Products</option>
                {products.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select value={groupBy ?? ""} onChange={(e) => setGroupBy((e.target.value as GroupByMode) || null)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">No Grouping</option>
                <option value="theatre">Group by Theatre</option>
                <option value="region">Group by Region</option>
                <option value="country">Group by Country</option>
              </select>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("fullName")}>Full Name{sortIndicator("fullName")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("email")}>Email{sortIndicator("email")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("theatre")}>Theatre{sortIndicator("theatre")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("region")}>Region{sortIndicator("region")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("country")}>Country{sortIndicator("country")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("trainingTitle")}>Training{sortIndicator("trainingTitle")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("trainingType")}>Type{sortIndicator("trainingType")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("productType")}>Product{sortIndicator("productType")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("function")}>Function{sortIndicator("function")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("completedDate")}>Completed{sortIndicator("completedDate")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("expiryDate")}>Expires{sortIndicator("expiryDate")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("active")}>Active{sortIndicator("active")}</th>
                  <th className="px-4 py-3 text-left font-semibold"></th>
                </tr>
              </thead>
              {renderBody()}
            </table>
          </div>

          <div className="mt-4">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageChange={setPage}
              onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AchievementOverTimePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>}>
      <AchievementOverTimePageInner />
    </Suspense>
  );
}
