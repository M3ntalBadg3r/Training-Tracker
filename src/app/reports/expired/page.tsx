"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import GroupedRows from "@/components/data-table/GroupedRows";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { groupRows, GroupByMode, resolveBucket } from "@/lib/group-by";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import { Search, Download, ArrowLeft, CalendarX, AlertCircle, AlertTriangle, History } from "lucide-react";
import {
  BarChart,
  Bar,
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
  isLegacy: boolean;
}

const TYPES = ["Certification", "Accreditation", "Instructor-Led Training", "OLX"] as const;

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

// Buckets describe how long ago a record lapsed (oldest band lumps everything > 12 months).
const BUCKETS: { key: string; label: string }[] = [
  { key: "0-1", label: "≤ 1 month" },
  { key: "1-3", label: "1–3 months" },
  { key: "3-6", label: "3–6 months" },
  { key: "6-12", label: "6–12 months" },
  { key: "12+", label: "> 12 months" },
];

function monthsBetween(earlier: Date, later: Date): number {
  return (later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
}

function bucketLapse(expiry: Date, now: Date): string | null {
  if (expiry >= now) return null;
  const m = monthsBetween(expiry, now);
  if (m <= 1) return "0-1";
  if (m <= 3) return "1-3";
  if (m <= 6) return "3-6";
  if (m <= 12) return "6-12";
  return "12+";
}

export default function ExpiredPage() {
  const router = useRouter();
  const chart = useChartTheme();
  const { formatDate } = useDateFormat();
  const [trainingRecords, setTrainingRecords] = useState<TrainingRecordRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterTheatre, setFilterTheatre] = useState("");
  const [filterBucket, setFilterBucket] = useState<string | null>(null);
  const [excludeRetired, setExcludeRetired] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupByMode | null>("theatre");

  const now = useMemo(() => new Date(), []);

  const companyScope = useCompanyScope();

  useEffect(() => {
    if (companyScope.loading) return;
    setLoading(true);
    fetch(withCompany("/api/reports/training-records", companyScope.selected))
      .then((r) => r.json())
      .then((d) => { setTrainingRecords(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [companyScope.loading, companyScope.selected]);

  const types = useMemo(() => [...new Set(trainingRecords.map((r) => r.trainingType))].filter(Boolean).sort(), [trainingRecords]);
  const theatres = useMemo(() => [...new Set(trainingRecords.map((r) => r.theatre))].filter(Boolean).sort(), [trainingRecords]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return trainingRecords.filter((r) => {
      const expiry = new Date(r.expiryDate);
      if (expiry >= now) return false; // only records that have already lapsed
      if (excludeRetired && r.isLegacy) return false;
      if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (filterType && r.trainingType !== filterType) return false;
      if (filterTheatre && r.theatre !== filterTheatre) return false;
      if (filterBucket) {
        const b = bucketLapse(expiry, now);
        if (b !== filterBucket) return false;
      }
      return true;
    });
  }, [trainingRecords, search, filterType, filterTheatre, filterBucket, excludeRetired, now]);

  const bucketSeries = useMemo(() => {
    const counts: Record<string, { name: string; Certification: number; Accreditation: number; "Instructor-Led Training": number; OLX: number }> = {};
    for (const b of BUCKETS) {
      counts[b.key] = { name: b.label, Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 };
    }
    for (const r of filtered) {
      const b = bucketLapse(new Date(r.expiryDate), now);
      if (!b) continue;
      const key = r.trainingType as (typeof TYPES)[number];
      if (TYPES.includes(key)) counts[b][key]++;
    }
    return BUCKETS.map((b) => ({ ...counts[b.key], bucketKey: b.key }));
  }, [filtered, now]);

  const theatreSeries = useMemo(() => {
    const byTheatre = new Map<string, { name: string; Certification: number; Accreditation: number; "Instructor-Led Training": number; OLX: number }>();
    for (const r of filtered) {
      const t = r.theatre || "Unknown";
      if (!byTheatre.has(t)) byTheatre.set(t, { name: t, Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 });
      const key = r.trainingType as (typeof TYPES)[number];
      if (TYPES.includes(key)) byTheatre.get(t)![key]++;
    }
    return [...byTheatre.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [filtered]);

  const kpis = useMemo(
    () => ({
      total: filtered.length,
      m1: filtered.filter((r) => bucketLapse(new Date(r.expiryDate), now) === "0-1").length,
      m3: filtered.filter((r) => {
        const b = bucketLapse(new Date(r.expiryDate), now);
        return b === "0-1" || b === "1-3";
      }).length,
      longOverdue: filtered.filter((r) => bucketLapse(new Date(r.expiryDate), now) === "12+").length,
    }),
    [filtered, now]
  );

  const grouped = useMemo(() => groupRows(filtered, groupBy ?? "theatre"), [filtered, groupBy]);

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
    { key: "retired", header: "Retired" },
  ];
  const exportRows = filtered.map((r) => ({
    ...r,
    completedDate: formatDate(r.completedDate),
    expiryDate: formatDate(r.expiryDate),
    retired: r.isLegacy ? "Yes" : "No",
  }));

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>;
  }

  // Avoid unused import warning when grouping by something other than theatre
  void resolveBucket;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Reports
        </Link>
      </div>
      <PageHeader title="Currently Expired" helpSlug="reports" />

      <KpiStrip
        cards={[
          { label: "Total Expired", value: kpis.total, icon: CalendarX, tone: "red" },
          { label: "Lapsed ≤ 1 month", value: kpis.m1, icon: AlertCircle, tone: "amber" },
          { label: "Lapsed ≤ 3 months", value: kpis.m3, icon: AlertTriangle, tone: "indigo" },
          { label: "Overdue > 12 months", value: kpis.longOverdue, icon: History, tone: "red" },
        ]}
      />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">How Long Ago They Lapsed</h3>
            {filterBucket && (
              <button onClick={() => setFilterBucket(null)} className="text-xs text-blue-600 hover:underline">Clear band filter</button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={bucketSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Bar dataKey="Certification" stackId="a" fill={chart.typeColor("Certification")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { bucketKey?: string }).bucketKey; if (k) setFilterBucket(k); }) as never} />
              <Bar dataKey="Accreditation" stackId="a" fill={chart.typeColor("Accreditation")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { bucketKey?: string }).bucketKey; if (k) setFilterBucket(k); }) as never} />
              <Bar dataKey="Instructor-Led Training" stackId="a" fill={chart.typeColor("Instructor-Led Training")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { bucketKey?: string }).bucketKey; if (k) setFilterBucket(k); }) as never} />
              <Bar dataKey="OLX" stackId="a" fill={chart.typeColor("OLX")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { bucketKey?: string }).bucketKey; if (k) setFilterBucket(k); }) as never} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-400 mt-2">Click a band to filter the table to that lapse age</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Expired by Theatre</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={theatreSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Bar dataKey="Certification" stackId="a" fill={chart.typeColor("Certification")} />
              <Bar dataKey="Accreditation" stackId="a" fill={chart.typeColor("Accreditation")} />
              <Bar dataKey="Instructor-Led Training" stackId="a" fill={chart.typeColor("Instructor-Led Training")} />
              <Bar dataKey="OLX" stackId="a" fill={chart.typeColor("OLX")} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">Certifications &amp; trainings whose latest completion has already expired</p>
          <span className="text-sm font-medium text-gray-500">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
              </div>
              <ExportMenu data={exportRows as never} columns={exportColumns} filename="currently-expired" />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Types</option>
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={filterTheatre} onChange={(e) => setFilterTheatre(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Theatres</option>
                {theatres.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={groupBy ?? ""} onChange={(e) => setGroupBy((e.target.value as GroupByMode) || null)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">No Grouping</option>
                <option value="theatre">Group by Theatre</option>
                <option value="region">Group by Region</option>
                <option value="country">Group by Country</option>
              </select>
              <label className="flex items-center gap-2 text-sm text-gray-600 select-none">
                <input type="checkbox" checked={excludeRetired} onChange={(e) => setExcludeRetired(e.target.checked)} className="rounded border-gray-300" />
                Exclude retired (legacy) certs
              </label>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold">Full Name</th>
                  <th className="px-4 py-3 text-left font-semibold">Email</th>
                  <th className="px-4 py-3 text-left font-semibold">Theatre</th>
                  <th className="px-4 py-3 text-left font-semibold">Region</th>
                  <th className="px-4 py-3 text-left font-semibold">Country</th>
                  <th className="px-4 py-3 text-left font-semibold">Training</th>
                  <th className="px-4 py-3 text-left font-semibold">Type</th>
                  <th className="px-4 py-3 text-left font-semibold">Product</th>
                  <th className="px-4 py-3 text-left font-semibold">Function</th>
                  <th className="px-4 py-3 text-left font-semibold">Completed</th>
                  <th className="px-4 py-3 text-left font-semibold">Expired</th>
                  <th className="px-4 py-3 text-left font-semibold"></th>
                </tr>
              </thead>
              <GroupedRows
                groups={grouped}
                groupBy={groupBy}
                colSpanTotal={12}
                emptyMessage="No expired records match the current filters."
                renderRow={(row, idx) => (
                  <tr key={`${row.email}-${row.trainingTitle}-${idx}`} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3">{row.fullName}</td>
                    <td className="px-4 py-3">{row.email}</td>
                    <td className="px-4 py-3">{row.theatre || "-"}</td>
                    <td className="px-4 py-3">{row.region || "-"}</td>
                    <td className="px-4 py-3">{row.country || "-"}</td>
                    <td className="px-4 py-3">
                      {row.trainingTitle}
                      {row.isLegacy && (
                        <span className="ml-2 inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-600">Retired</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${typeBadgeClass(row.trainingType)}`}>
                        {row.trainingType}
                      </span>
                    </td>
                    <td className="px-4 py-3">{row.productType}</td>
                    <td className="px-4 py-3">{row.function}</td>
                    <td className="px-4 py-3">{formatDate(row.completedDate)}</td>
                    <td className="px-4 py-3 text-red-700 font-medium">{formatDate(row.expiryDate)}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => router.push(`/students/${encodeURIComponent(row.email)}`)} className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors">View</button>
                    </td>
                  </tr>
                )}
                renderSubtotal={(g) => (
                  <td colSpan={12} className="px-4 py-2">
                    Subtotal — {g.rows.length} expired record{g.rows.length !== 1 ? "s" : ""}
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
