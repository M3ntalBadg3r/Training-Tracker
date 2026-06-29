"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import GroupedRows from "@/components/data-table/GroupedRows";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { groupRows, GroupByMode, resolveBucket } from "@/lib/group-by";
import { useTableSort, SortAccessor } from "@/hooks/useTableSort";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import { Search, Download, ArrowLeft, Clock, AlertTriangle, AlertCircle, CalendarClock } from "lucide-react";
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

const HORIZONS: { key: string; label: string; months: number }[] = [
  { key: "0-1", label: "≤ 1 month", months: 1 },
  { key: "1-3", label: "1–3 months", months: 3 },
  { key: "3-6", label: "3–6 months", months: 6 },
  { key: "6-12", label: "6–12 months", months: 12 },
];

function monthsBetween(now: Date, future: Date): number {
  return (future.getFullYear() - now.getFullYear()) * 12 + (future.getMonth() - now.getMonth());
}

function bucketHorizon(expiry: Date, now: Date): string | null {
  if (expiry <= now) return null;
  const m = monthsBetween(now, expiry);
  if (m <= 1) return "0-1";
  if (m <= 3) return "1-3";
  if (m <= 6) return "3-6";
  if (m <= 12) return "6-12";
  return null;
}

export default function ExpiringSoonPage() {
  const router = useRouter();
  const chart = useChartTheme();
  const { formatDate } = useDateFormat();
  const [trainingRecords, setTrainingRecords] = useState<TrainingRecordRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [filterWindow, setFilterWindow] = useState("12");
  const [filterType, setFilterType] = useState("");
  const [filterTheatre, setFilterTheatre] = useState("");
  const [filterHorizon, setFilterHorizon] = useState<string | null>(null);
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
    const months = parseInt(filterWindow);
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() + months);
    return trainingRecords.filter((r) => {
      const expiry = new Date(r.expiryDate);
      if (expiry <= now || expiry > cutoff) return false;
      if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (filterType && r.trainingType !== filterType) return false;
      if (filterTheatre && r.theatre !== filterTheatre) return false;
      if (filterHorizon) {
        const b = bucketHorizon(expiry, now);
        if (b !== filterHorizon) return false;
      }
      return true;
    });
  }, [trainingRecords, search, filterWindow, filterType, filterTheatre, filterHorizon, now]);

  const horizonSeries = useMemo(() => {
    const counts: Record<string, { name: string; Certification: number; Accreditation: number; "Instructor-Led Training": number; OLX: number }> = {};
    for (const h of HORIZONS) {
      counts[h.key] = { name: h.label, Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 };
    }
    for (const r of filtered) {
      const expiry = new Date(r.expiryDate);
      const b = bucketHorizon(expiry, now);
      if (!b) continue;
      const key = r.trainingType as (typeof TYPES)[number];
      if (TYPES.includes(key)) counts[b][key]++;
    }
    return HORIZONS.map((h) => ({ ...counts[h.key], horizonKey: h.key }));
  }, [filtered, now]);

  // Theatre × month heatmap as a stacked bar (months on X axis, one bar per theatre series)
  const heatmapMonths = useMemo(() => {
    const months: { key: string; label: string }[] = [];
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    for (let i = 0; i < 12; i++) {
      const d = new Date(start);
      d.setMonth(start.getMonth() + i);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
      });
    }
    return months;
  }, [now]);

  const heatmapTheatres = useMemo(() => [...new Set(filtered.map((r) => r.theatre))].filter(Boolean).sort(), [filtered]);

  const heatmapData = useMemo(() => {
    const rows = heatmapMonths.map((m) => ({ month: m.label } as Record<string, string | number>));
    for (const t of heatmapTheatres) rows.forEach((r) => (r[t] = 0));
    for (const r of filtered) {
      const expiry = new Date(r.expiryDate);
      const key = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, "0")}`;
      const idx = heatmapMonths.findIndex((m) => m.key === key);
      if (idx === -1) continue;
      const target = rows[idx];
      target[r.theatre] = ((target[r.theatre] as number) || 0) + 1;
    }
    return rows;
  }, [filtered, heatmapMonths, heatmapTheatres]);

  const kpis = useMemo(
    () => ({
      total: filtered.length,
      m1: filtered.filter((r) => bucketHorizon(new Date(r.expiryDate), now) === "0-1").length,
      m3: filtered.filter((r) => {
        const b = bucketHorizon(new Date(r.expiryDate), now);
        return b === "0-1" || b === "1-3";
      }).length,
      m6: filtered.filter((r) => {
        const b = bucketHorizon(new Date(r.expiryDate), now);
        return b === "0-1" || b === "1-3" || b === "3-6";
      }).length,
    }),
    [filtered, now]
  );

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

  // Avoid unused import warning when grouping by something other than theatre
  void resolveBucket;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Reports
        </Link>
      </div>
      <PageHeader title="Expiring Soon" helpSlug="reports" />

      <KpiStrip
        cards={[
          { label: "In Window", value: kpis.total, icon: CalendarClock, tone: "blue" },
          { label: "≤ 1 month", value: kpis.m1, icon: AlertCircle, tone: "red" },
          { label: "≤ 3 months", value: kpis.m3, icon: AlertTriangle, tone: "amber" },
          { label: "≤ 6 months", value: kpis.m6, icon: Clock, tone: "indigo" },
        ]}
      />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">Expiry Horizon</h3>
            {filterHorizon && (
              <button onClick={() => setFilterHorizon(null)} className="text-xs text-blue-600 hover:underline">Clear horizon filter</button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={horizonSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Bar dataKey="Certification" stackId="a" fill={chart.typeColor("Certification")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { horizonKey?: string }).horizonKey; if (k) setFilterHorizon(k); }) as never} />
              <Bar dataKey="Accreditation" stackId="a" fill={chart.typeColor("Accreditation")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { horizonKey?: string }).horizonKey; if (k) setFilterHorizon(k); }) as never} />
              <Bar dataKey="Instructor-Led Training" stackId="a" fill={chart.typeColor("Instructor-Led Training")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { horizonKey?: string }).horizonKey; if (k) setFilterHorizon(k); }) as never} />
              <Bar dataKey="OLX" stackId="a" fill={chart.typeColor("OLX")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { horizonKey?: string }).horizonKey; if (k) setFilterHorizon(k); }) as never} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-400 mt-2">Click a band to filter the table to that horizon</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Expiries by Theatre × Month</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={heatmapData}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              {heatmapTheatres.map((t, i) => (
                <Bar key={t} dataKey={t} stackId="a" fill={chart.series(i)} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">Training records expiring within the next {filterWindow} months</p>
          <span className="text-sm font-medium text-gray-500">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
              </div>
              <ExportMenu data={exportRows as never} columns={exportColumns} filename="expiring-soon" />
            </div>
            <div className="flex flex-wrap gap-3">
              <select value={filterWindow} onChange={(e) => setFilterWindow(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="1">Within 1 Month</option>
                <option value="3">Within 3 Months</option>
                <option value="6">Within 6 Months</option>
                <option value="12">Within 12 Months</option>
              </select>
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
                emptyMessage="No records expiring within the selected window."
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
                    Subtotal — {g.rows.length} expiring record{g.rows.length !== 1 ? "s" : ""}
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
