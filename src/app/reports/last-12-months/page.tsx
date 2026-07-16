"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import GroupedRows from "@/components/data-table/GroupedRows";
import DateRangePicker, { DateRangeValue } from "@/components/ui/DateRangePicker";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { useProductTypeColors } from "@/hooks/useProductTypeColors";
import { groupRows, GroupByMode } from "@/lib/group-by";
import { useTableSort, SortAccessor } from "@/hooks/useTableSort";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import GeoScopeFilter, { GeoScope, EMPTY_GEO_SCOPE } from "@/components/reports/GeoScopeFilter";
import { Search, Download, ArrowLeft, Award, ShieldCheck, GraduationCap, TrendingUp } from "lucide-react";
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

const TYPES = ["Certification", "Accreditation", "Instructor-Led Training", "OLX"] as const;

type RangePreset = "12m" | "6m" | "3m" | "1m" | "custom";

const RANGE_PRESETS: { value: RangePreset; label: string; months: number | null }[] = [
  { value: "12m", label: "Last 12 months", months: 12 },
  { value: "6m", label: "Last 6 months", months: 6 },
  { value: "3m", label: "Last 3 months", months: 3 },
  { value: "1m", label: "Last 1 month", months: 1 },
  { value: "custom", label: "Custom range", months: null },
];

function typeBadgeClass(t: string): string {
  if (t === "Certification") return "bg-blue-100 text-blue-800";
  if (t === "Accreditation") return "bg-emerald-100 text-emerald-800";
  if (t === "OLX") return "bg-sky-100 text-sky-800";
  return "bg-amber-100 text-amber-800";
}

function ExportMenu({ data, columns, filename }: { data: Record<string, unknown>[]; columns: { key: string; header: string }[]; filename: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setShow((p) => !p)} className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">
        <Download size={16} /> Export
      </button>
      {show && (
        <div className="absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
          <button onClick={() => { exportToCsv(data, columns as never, filename); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg">Export as CSV</button>
          <button onClick={() => { exportToExcel(data, columns as never, filename); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100">Export as Excel</button>
          <button onClick={() => { exportToPdf(data, columns as never, filename); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg">Export as PDF</button>
        </div>
      )}
    </div>
  );
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function weekStart(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay();
  const diff = (day + 6) % 7; // Monday-start week
  x.setDate(x.getDate() - diff);
  return x;
}

function weekKey(d: Date): string {
  return dayKey(weekStart(d));
}

type Granularity = "day" | "week" | "month";

export default function AchievementOverTimePage() {
  const router = useRouter();
  const chart = useChartTheme();
  const productColors = useProductTypeColors();
  const { formatDate } = useDateFormat();
  const companyScope = useCompanyScope();
  const { data: recordsData, loading } = useFetchJson<TrainingRecordRow[]>(
    withCompany("/api/reports/training-records", companyScope.selected),
    { enabled: !companyScope.loading }
  );
  const trainingRecords = useMemo(() => recordsData ?? [], [recordsData]);

  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [geo, setGeo] = useState<GeoScope>(EMPTY_GEO_SCOPE);
  const [filterFunction, setFilterFunction] = useState("");
  const [filterProduct, setFilterProduct] = useState("");
  const [filterBucket, setFilterBucket] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupByMode | null>(null);

  const [rangePreset, setRangePreset] = useState<RangePreset>("12m");
  const [customRange, setCustomRange] = useState<DateRangeValue>({ from: null, to: null });

  const now = useMemo(() => new Date(), []);

  const types = useMemo(() => [...new Set(trainingRecords.map((r) => r.trainingType))].filter(Boolean).sort(), [trainingRecords]);
  const functions = useMemo(() => [...new Set(trainingRecords.map((r) => r.function))].filter(Boolean).sort(), [trainingRecords]);
  const products = useMemo(() => [...new Set(trainingRecords.map((r) => r.productType))].filter(Boolean).sort(), [trainingRecords]);

  // Earliest completion date in the current dataset — used to tighten the
  // chart axis when the window has no lower bound ("All time").
  const earliestCompleted = useMemo(() => {
    let min: number | null = null;
    for (const r of trainingRecords) {
      const t = new Date(r.completedDate).getTime();
      if (Number.isFinite(t) && (min === null || t < min)) min = t;
    }
    return min === null ? null : new Date(min);
  }, [trainingRecords]);

  // Resolve current window. Null from/to mean "no constraint", matching the
  // DateRangePicker "All time" preset and filterByRange() semantics.
  const { windowStart, windowEnd, isAllTime } = useMemo(() => {
    if (rangePreset === "custom") {
      const noFrom = !customRange.from;
      const from = customRange.from ? startOfDay(customRange.from) : new Date(0);
      const to = customRange.to ? endOfDay(customRange.to) : endOfDay(now);
      return { windowStart: from, windowEnd: to, isAllTime: noFrom };
    }
    const months = RANGE_PRESETS.find((p) => p.value === rangePreset)?.months ?? 12;
    const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    return { windowStart: startOfDay(start), windowEnd: endOfDay(now), isAllTime: false };
  }, [rangePreset, customRange, now]);

  // For axis rendering only, start the chart at the earliest record rather
  // than 1970 when the window is "All time".
  const axisStart = useMemo(() => {
    if (isAllTime && earliestCompleted) return startOfDay(earliestCompleted);
    return windowStart;
  }, [isAllTime, earliestCompleted, windowStart]);

  // Prior window — same length immediately before windowStart
  const { priorStart, priorEnd } = useMemo(() => {
    const lenMs = windowEnd.getTime() - windowStart.getTime();
    const priorE = new Date(windowStart.getTime() - 1);
    const priorS = new Date(priorE.getTime() - lenMs);
    return { priorStart: priorS, priorEnd: priorE };
  }, [windowStart, windowEnd]);

  // Decide bucket granularity based on the visible axis span (uses axisStart
  // so "All time" buckets at the real data span, not 1970→now).
  const granularity: Granularity = useMemo(() => {
    const days = Math.max(1, Math.round((windowEnd.getTime() - axisStart.getTime()) / 86400000));
    if (days <= 35) return "day";
    if (days <= 100) return "week";
    return "month";
  }, [axisStart, windowEnd]);

  const bucketKey = useMemo(() => {
    if (granularity === "day") return dayKey;
    if (granularity === "week") return weekKey;
    return monthKey;
  }, [granularity]);

  // Records filtered for the table (window + search + type + theatre + bucket click)
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return trainingRecords.filter((r) => {
      const completed = new Date(r.completedDate);
      if (completed < windowStart || completed > windowEnd) return false;
      if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (filterType && r.trainingType !== filterType) return false;
      if (geo.theatre && r.theatre !== geo.theatre) return false;
      if (geo.region && r.region !== geo.region) return false;
      if (geo.country && r.country !== geo.country) return false;
      if (filterFunction && r.function !== filterFunction) return false;
      if (filterProduct && r.productType !== filterProduct) return false;
      if (filterBucket && bucketKey(completed) !== filterBucket) return false;
      return true;
    });
  }, [trainingRecords, search, filterType, geo, filterFunction, filterProduct, filterBucket, windowStart, windowEnd, bucketKey]);

  // Records used to build the chart — same filters as the table EXCEPT bucket click
  const chartRecords = useMemo(() => {
    const q = search.toLowerCase();
    return trainingRecords.filter((r) => {
      if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (filterType && r.trainingType !== filterType) return false;
      if (geo.theatre && r.theatre !== geo.theatre) return false;
      if (geo.region && r.region !== geo.region) return false;
      if (geo.country && r.country !== geo.country) return false;
      if (filterFunction && r.function !== filterFunction) return false;
      if (filterProduct && r.productType !== filterProduct) return false;
      return true;
    });
  }, [trainingRecords, search, filterType, geo, filterFunction, filterProduct]);

  // Build bucket axis for the chart. Use axisStart (the earliest record when
  // "All time" is selected) so we don't render decades of empty leading
  // buckets back to 1970.
  const buckets = useMemo(() => {
    const out: { key: string; label: string; date: Date }[] = [];
    if (granularity === "month") {
      const start = new Date(axisStart.getFullYear(), axisStart.getMonth(), 1);
      let d = start;
      while (d <= windowEnd) {
        out.push({
          key: monthKey(d),
          label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
          date: new Date(d),
        });
        d = addMonths(d, 1);
      }
    } else if (granularity === "week") {
      let d = weekStart(axisStart);
      while (d <= windowEnd) {
        out.push({
          key: weekKey(d),
          label: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
          date: new Date(d),
        });
        d = addDays(d, 7);
      }
    } else {
      let d = startOfDay(axisStart);
      while (d <= windowEnd) {
        out.push({
          key: dayKey(d),
          label: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
          date: new Date(d),
        });
        d = addDays(d, 1);
      }
    }
    return out;
  }, [axisStart, windowEnd, granularity]);

  const chartData = useMemo(() => {
    const counts = new Map<string, number>();
    const priorCounts = new Map<string, number>();
    const shiftMs = windowStart.getTime() - priorStart.getTime();
    for (const r of chartRecords) {
      const completed = new Date(r.completedDate);
      if (completed >= windowStart && completed <= windowEnd) {
        const k = bucketKey(completed);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      } else if (completed >= priorStart && completed <= priorEnd) {
        // Align prior period onto the current axis by shifting forward by the window length
        const aligned = new Date(completed.getTime() + shiftMs);
        const ak = bucketKey(aligned);
        priorCounts.set(ak, (priorCounts.get(ak) ?? 0) + 1);
      }
    }
    return buckets.map((b) => ({
      bucketKey: b.key,
      label: b.label,
      "This period": counts.get(b.key) ?? 0,
      "Prior period": priorCounts.get(b.key) ?? 0,
    }));
  }, [chartRecords, buckets, bucketKey, windowStart, windowEnd, priorStart, priorEnd]);

  const topTitles = useMemo(() => {
    const counts = new Map<string, number>();
    const productByTitle = new Map<string, string>();
    for (const r of filtered) {
      counts.set(r.trainingTitle, (counts.get(r.trainingTitle) ?? 0) + 1);
      if (r.productType && !productByTitle.has(r.trainingTitle)) {
        productByTitle.set(r.trainingTitle, r.productType);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([title, count]) => ({ title, count, productType: productByTitle.get(title) ?? "" }));
  }, [filtered]);

  const kpis = useMemo(() => {
    const thisPeriodTotal = chartData.reduce((s, m) => s + (m["This period"] as number), 0);
    const priorPeriodTotal = chartData.reduce((s, m) => s + (m["Prior period"] as number), 0);
    const change = priorPeriodTotal === 0 ? 0 : ((thisPeriodTotal - priorPeriodTotal) / priorPeriodTotal) * 100;
    return {
      total: filtered.length,
      cert: filtered.filter((r) => r.trainingType === "Certification").length,
      accred: filtered.filter((r) => r.trainingType === "Accreditation").length,
      ilt: filtered.filter((r) => r.trainingType === "Instructor-Led Training").length,
      olx: filtered.filter((r) => r.trainingType === "OLX").length,
      thisPeriodTotal,
      priorPeriodTotal,
      change,
    };
  }, [filtered, chartData]);

  void TYPES;

  // Column sorting (applied before grouping so rows sort within each group).
  const sortAccessors: Record<string, SortAccessor<TrainingRecordRow>> = {
    fullName: (r) => r.fullName,
    email: (r) => r.email,
    theatre: (r) => r.theatre,
    region: (r) => r.region,
    country: (r) => r.country,
    trainingTitle: (r) => r.trainingTitle,
    trainingType: (r) => r.trainingType,
    productType: (r) => r.productType,
    function: (r) => r.function,
    completedDate: (r) => r.completedDate,
    expiryDate: (r) => r.expiryDate,
    active: (r) => r.active,
  };
  const { sorted, toggleSort, sortIndicator } = useTableSort(filtered, sortAccessors, {
    defaultKey: "fullName",
    tiebreakKey: "fullName",
  });

  const grouped = useMemo(() => groupRows(sorted, groupBy ?? "theatre"), [sorted, groupBy]);

  const granularityLabel = granularity === "day" ? "Daily" : granularity === "week" ? "Weekly" : "Monthly";
  const bucketLabel = granularity === "day" ? "day" : granularity === "week" ? "week" : "month";

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
  const exportRows = filtered.map((r) => ({
    ...r,
    completedDate: formatDate(r.completedDate),
    expiryDate: formatDate(r.expiryDate),
    active: r.active ? "Yes" : "No",
  }));

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
          <span className="text-sm font-medium text-gray-500">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
              </div>
              <ExportMenu data={exportRows as never} columns={exportColumns} filename="achievement-over-time" />
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
              <GroupedRows
                groups={grouped}
                groupBy={groupBy}
                colSpanTotal={13}
                emptyMessage="No records found in the selected range."
                renderRow={(row, idx) => (
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
                )}
                renderSubtotal={(g) => (
                  <td colSpan={13} className="px-4 py-2">
                    Subtotal — {g.rows.length} record{g.rows.length !== 1 ? "s" : ""}
                  </td>
                )}
              />
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
