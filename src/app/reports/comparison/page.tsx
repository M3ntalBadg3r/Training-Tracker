"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { resolveBucket, GroupByMode, GROUP_BY_LABEL } from "@/lib/group-by";
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

interface StudentRow {
  email: string;
  fullName: string;
  theatre: string | null;
  country: string | null;
  region: string | null;
}

type RangePreset = "12m" | "6m" | "3m" | "all";

const RANGE_PRESETS: { value: RangePreset; label: string; months: number | null }[] = [
  { value: "12m", label: "Last 12 months", months: 12 },
  { value: "6m", label: "Last 6 months", months: 6 },
  { value: "3m", label: "Last 3 months", months: 3 },
  { value: "all", label: "All time", months: null },
];

type CompareMode = "type" | "function" | "product" | "time";

const COMPARE_MODES: { value: CompareMode; label: string }[] = [
  { value: "type", label: "By Training Type" },
  { value: "function", label: "By Function" },
  { value: "product", label: "By Product" },
  { value: "time", label: "Over Time" },
];

const TYPE_ORDER = ["Certification", "Accreditation", "Instructor-Led Training", "OLX"] as const;

type SortKey =
  | "bucket"
  | "headcount"
  | "cert"
  | "accred"
  | "ilt"
  | "olx"
  | "total"
  | "perStudent"
  | "exp3"
  | "exp6";

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
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

export default function ComparisonPage() {
  const chart = useChartTheme();
  const companyScope = useCompanyScope();

  const [records, setRecords] = useState<TrainingRecordRow[]>([]);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [geoMode, setGeoMode] = useState<GroupByMode>("theatre");
  const [rangePreset, setRangePreset] = useState<RangePreset>("12m");
  const [filterFunction, setFilterFunction] = useState("");
  const [filterProduct, setFilterProduct] = useState("");
  const [filterType, setFilterType] = useState("");
  const [compareMode, setCompareMode] = useState<CompareMode>("type");
  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const now = useMemo(() => new Date(), []);

  useEffect(() => {
    if (companyScope.loading) return;
    setLoading(true);
    Promise.all([
      fetch(withCompany("/api/reports/training-records", companyScope.selected)).then((r) => r.json()),
      fetch(withCompany("/api/students", companyScope.selected)).then((r) => r.json()),
    ])
      .then(([recs, studs]) => {
        setRecords(Array.isArray(recs) ? recs : []);
        setStudents(Array.isArray(studs) ? studs : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [companyScope.loading, companyScope.selected]);

  const functions = useMemo(() => [...new Set(records.map((r) => r.function))].filter(Boolean).sort(), [records]);
  const products = useMemo(() => [...new Set(records.map((r) => r.productType))].filter(Boolean).sort(), [records]);
  const types = useMemo(() => [...new Set(records.map((r) => r.trainingType))].filter(Boolean).sort(), [records]);

  // Lower bound for the completion time-range (null = all time).
  const windowStart = useMemo(() => {
    const months = RANGE_PRESETS.find((p) => p.value === rangePreset)?.months ?? null;
    if (months === null) return null;
    const d = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [rangePreset, now]);

  // Records passing the function/product/type filters (used everywhere). The
  // time-range is applied separately so expiring-soon can ignore it.
  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      if (filterFunction && r.function !== filterFunction) return false;
      if (filterProduct && r.productType !== filterProduct) return false;
      if (filterType && r.trainingType !== filterType) return false;
      return true;
    });
  }, [records, filterFunction, filterProduct, filterType]);

  // Headcount per bucket — distinct students at the chosen geo level.
  const headcountByBucket = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of students) {
      const b = resolveBucket(s, geoMode);
      m.set(b, (m.get(b) ?? 0) + 1);
    }
    return m;
  }, [students, geoMode]);

  const exp3Cutoff = useMemo(() => addMonths(now, 3), [now]);
  const exp6Cutoff = useMemo(() => addMonths(now, 6), [now]);

  // Per-bucket comparison metrics.
  const metrics: BucketMetrics[] = useMemo(() => {
    const map = new Map<string, BucketMetrics>();
    const ensure = (bucket: string): BucketMetrics => {
      let row = map.get(bucket);
      if (!row) {
        row = { bucket, headcount: 0, cert: 0, accred: 0, ilt: 0, olx: 0, total: 0, perStudent: 0, exp3: 0, exp6: 0 };
        map.set(bucket, row);
      }
      return row;
    };

    // Seed buckets from headcount so geographies with students but no
    // completions in-window still appear.
    for (const [bucket, count] of headcountByBucket) ensure(bucket).headcount = count;

    for (const r of filteredRecords) {
      const bucket = resolveBucket(r, geoMode);
      const row = ensure(bucket);

      const completed = new Date(r.completedDate);
      const inWindow = !windowStart || completed >= windowStart;
      if (inWindow) {
        row.total += 1;
        if (r.trainingType === "Certification") row.cert += 1;
        else if (r.trainingType === "Accreditation") row.accred += 1;
        else if (r.trainingType === "Instructor-Led Training") row.ilt += 1;
        else if (r.trainingType === "OLX") row.olx += 1;
      }

      // Expiring-soon is forward-from-today and ignores the completion window.
      if (r.active && r.expiryDate) {
        const exp = new Date(r.expiryDate);
        if (exp >= now && exp <= exp6Cutoff) {
          row.exp6 += 1;
          if (exp <= exp3Cutoff) row.exp3 += 1;
        }
      }
    }

    for (const row of map.values()) {
      row.perStudent = row.headcount > 0 ? row.total / row.headcount : 0;
    }
    return Array.from(map.values());
  }, [filteredRecords, headcountByBucket, geoMode, windowStart, now, exp3Cutoff, exp6Cutoff]);

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

  const totals = useMemo(() => {
    return metrics.reduce(
      (acc, r) => {
        acc.headcount += r.headcount;
        acc.cert += r.cert;
        acc.accred += r.accred;
        acc.ilt += r.ilt;
        acc.olx += r.olx;
        acc.total += r.total;
        acc.exp3 += r.exp3;
        acc.exp6 += r.exp6;
        return acc;
      },
      { headcount: 0, cert: 0, accred: 0, ilt: 0, olx: 0, total: 0, exp3: 0, exp6: 0 },
    );
  }, [metrics]);

  // Records within the completion window (for the chart breakdowns).
  const windowedRecords = useMemo(() => {
    if (!windowStart) return filteredRecords;
    return filteredRecords.filter((r) => new Date(r.completedDate) >= windowStart);
  }, [filteredRecords, windowStart]);

  // Top buckets by total trainings, used to cap chart series for readability.
  const topBuckets = useMemo(() => {
    return [...metrics].sort((a, b) => b.total - a.total).slice(0, 8).map((m) => m.bucket);
  }, [metrics]);

  // Grouped-bar chart data for type/function/product comparisons.
  const breakdownChart = useMemo(() => {
    if (compareMode === "time") return { rows: [], series: [] as string[] };
    const seriesSet = new Set<string>();
    const byBucket = new Map<string, Record<string, number>>();
    for (const r of windowedRecords) {
      const bucket = resolveBucket(r, geoMode);
      const cat = compareMode === "type" ? r.trainingType : compareMode === "function" ? r.function : r.productType;
      if (!cat) continue;
      seriesSet.add(cat);
      let entry = byBucket.get(bucket);
      if (!entry) { entry = {}; byBucket.set(bucket, entry); }
      entry[cat] = (entry[cat] ?? 0) + 1;
    }
    const series = compareMode === "type"
      ? TYPE_ORDER.filter((t) => seriesSet.has(t))
      : [...seriesSet].sort();
    const rows = [...byBucket.entries()]
      .map(([bucket, counts]) => ({ bucket, ...series.reduce((o, s) => ({ ...o, [s]: counts[s] ?? 0 }), {}) }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));
    return { rows, series: series as string[] };
  }, [windowedRecords, compareMode, geoMode]);

  // Over-time line chart: month buckets across the window, one line per geography.
  const timeChart = useMemo(() => {
    if (compareMode !== "time") return { rows: [], series: [] as string[] };
    const start = windowStart ?? (() => {
      let min: number | null = null;
      for (const r of windowedRecords) {
        const t = new Date(r.completedDate).getTime();
        if (Number.isFinite(t) && (min === null || t < min)) min = t;
      }
      return min === null ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(min);
    })();
    const months: { key: string; label: string }[] = [];
    let d = new Date(start.getFullYear(), start.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    while (d <= end) {
      months.push({ key: monthKey(d), label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }) });
      d = addMonths(d, 1);
    }
    const series = topBuckets;
    const counts = new Map<string, Record<string, number>>();
    for (const r of windowedRecords) {
      const bucket = resolveBucket(r, geoMode);
      if (!series.includes(bucket)) continue;
      const k = monthKey(new Date(r.completedDate));
      let entry = counts.get(k);
      if (!entry) { entry = {}; counts.set(k, entry); }
      entry[bucket] = (entry[bucket] ?? 0) + 1;
    }
    const rows = months.map((m) => ({
      label: m.label,
      ...series.reduce((o, s) => ({ ...o, [s]: counts.get(m.key)?.[s] ?? 0 }), {}),
    }));
    return { rows, series };
  }, [compareMode, windowedRecords, geoMode, windowStart, topBuckets, now]);

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
  const exportRows = sortedMetrics.map((r) => ({ ...r, perStudent: r.perStudent.toFixed(1) }));

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "bucket" ? "asc" : "desc");
    }
  }

  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>;
  }

  const numHeader = (key: SortKey, label: string) => (
    <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none whitespace-nowrap" onClick={() => toggleSort(key)}>
      {label}{sortIndicator(key)}
    </th>
  );

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
          {compareMode === "time" ? (
            <LineChart data={timeChart.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              {timeChart.series.map((s, i) => (
                <Line key={s} type="monotone" dataKey={s} stroke={chart.series(i)} strokeWidth={2} dot={{ r: 2 }} />
              ))}
            </LineChart>
          ) : (
            <BarChart data={breakdownChart.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={60} interval={0} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              {breakdownChart.series.map((s, i) => (
                <Bar key={s} dataKey={s} fill={chart.series(i)} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
        {compareMode === "time" && timeChart.series.length === 8 && (
          <p className="text-xs text-gray-400 mt-2">Showing the top 8 {geoLabel.toLowerCase()}s by total completions.</p>
        )}
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">Counts reflect the selected time range and filters; expiring counts look forward from today.</p>
          <ExportMenu data={exportRows as never} columns={exportColumns} filename={`comparison-by-${geoMode}`} />
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
