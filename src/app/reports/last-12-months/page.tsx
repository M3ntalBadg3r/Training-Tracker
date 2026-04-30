"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import GroupedRows from "@/components/data-table/GroupedRows";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { groupRows, GroupByMode } from "@/lib/group-by";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { Search, Download, ArrowLeft, Award, ShieldCheck, GraduationCap, TrendingUp } from "lucide-react";
import {
  AreaChart,
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

const TYPES = ["Certification", "Accreditation", "Instructor-Led Training"] as const;

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

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function Last12MonthsPage() {
  const router = useRouter();
  const chart = useChartTheme();
  const [trainingRecords, setTrainingRecords] = useState<TrainingRecordRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterTheatre, setFilterTheatre] = useState("");
  const [filterMonth, setFilterMonth] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupByMode | null>(null);

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

  const last12Start = useMemo(() => new Date(now.getFullYear(), now.getMonth() - 11, 1), [now]);
  const prior12Start = useMemo(() => new Date(now.getFullYear() - 1, now.getMonth() - 11, 1), [now]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return trainingRecords.filter((r) => {
      const completed = new Date(r.completedDate);
      if (completed < last12Start || completed > now) return false;
      if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (filterType && r.trainingType !== filterType) return false;
      if (filterTheatre && r.theatre !== filterTheatre) return false;
      if (filterMonth && monthKey(completed) !== filterMonth) return false;
      return true;
    });
  }, [trainingRecords, search, filterType, filterTheatre, filterMonth, last12Start, now]);

  // Build last 12 months and prior 12 months series
  const months = useMemo(() => {
    const out: { key: string; label: string; date: Date }[] = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(last12Start);
      d.setMonth(last12Start.getMonth() + i);
      out.push({
        key: monthKey(d),
        label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
        date: d,
      });
    }
    return out;
  }, [last12Start]);

  const monthlyData = useMemo(() => {
    const counts = new Map<string, number>();
    const priorCounts = new Map<string, number>();
    for (const r of trainingRecords) {
      const completed = new Date(r.completedDate);
      const k = monthKey(completed);
      if (completed >= last12Start && completed <= now) {
        counts.set(k, (counts.get(k) ?? 0) + 1);
      } else if (completed >= prior12Start && completed < last12Start) {
        // align prior period to last12 month positions
        const aligned = new Date(completed);
        aligned.setFullYear(completed.getFullYear() + 1);
        const ak = monthKey(aligned);
        priorCounts.set(ak, (priorCounts.get(ak) ?? 0) + 1);
      }
    }
    return months.map((m) => ({
      monthKey: m.key,
      label: m.label,
      "This year": counts.get(m.key) ?? 0,
      "Prior year": priorCounts.get(m.key) ?? 0,
    }));
  }, [trainingRecords, months, last12Start, prior12Start, now]);

  const topTitles = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of filtered) m.set(r.trainingTitle, (m.get(r.trainingTitle) ?? 0) + 1);
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([title, count]) => ({ title, count }));
  }, [filtered]);

  const kpis = useMemo(() => {
    const thisYearTotal = monthlyData.reduce((s, m) => s + (m["This year"] as number), 0);
    const priorYearTotal = monthlyData.reduce((s, m) => s + (m["Prior year"] as number), 0);
    const change = priorYearTotal === 0 ? 0 : ((thisYearTotal - priorYearTotal) / priorYearTotal) * 100;
    return {
      total: filtered.length,
      cert: filtered.filter((r) => r.trainingType === "Certification").length,
      accred: filtered.filter((r) => r.trainingType === "Accreditation").length,
      ilt: filtered.filter((r) => r.trainingType === "Instructor-Led Training").length,
      thisYearTotal,
      priorYearTotal,
      change,
    };
  }, [filtered, monthlyData]);

  void TYPES;

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
    { key: "active", header: "Active" },
  ];
  const exportRows = filtered.map((r) => ({
    ...r,
    completedDate: new Date(r.completedDate).toLocaleDateString(),
    expiryDate: new Date(r.expiryDate).toLocaleDateString(),
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
      <PageHeader title="Achieved Over Last 12 Months" helpSlug="reports" />

      <KpiStrip
        cards={[
          { label: "This Year", value: kpis.thisYearTotal, icon: TrendingUp, tone: "blue", hint: `${kpis.change >= 0 ? "+" : ""}${kpis.change.toFixed(1)}% vs prior` },
          { label: "Certifications", value: kpis.cert, icon: Award, tone: "indigo" },
          { label: "Accreditations", value: kpis.accred, icon: ShieldCheck, tone: "emerald" },
          { label: "ILTs", value: kpis.ilt, icon: GraduationCap, tone: "amber" },
        ]}
      />

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="lg:col-span-2 bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">Monthly Completions vs Prior Year</h3>
            {filterMonth && (
              <button onClick={() => setFilterMonth(null)} className="text-xs text-blue-600 hover:underline">Clear month filter</button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={monthlyData} onClick={((e: unknown) => {
              const payload = (e as { activePayload?: { payload: { monthKey?: string } }[] })?.activePayload;
              const k = payload?.[0]?.payload?.monthKey;
              if (k) setFilterMonth(k);
            }) as never}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Area type="monotone" dataKey="This year" fill={chart.typeColor("Certification")} stroke={chart.typeColor("Certification")} fillOpacity={0.3} />
              <Line type="monotone" dataKey="Prior year" stroke={chart.axis} strokeDasharray="4 4" strokeWidth={2} dot={{ r: 2 }} />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-400 mt-2">Click a point to filter the table to that month</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Top 10 Trainings</h3>
          <div className="space-y-2">
            {topTitles.map((t, i) => {
              const max = topTitles[0]?.count ?? 1;
              const pct = (t.count / max) * 100;
              return (
                <div key={t.title}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-700 truncate pr-2">{i + 1}. {t.title}</span>
                    <span className="text-gray-500 font-medium">{t.count}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded">
                    <div className="h-2 rounded" style={{ width: `${pct}%`, backgroundColor: chart.series(i) }} />
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
          <p className="text-sm text-gray-500">Training records completed in the last 12 months</p>
          <span className="text-sm font-medium text-gray-500">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
              </div>
              <ExportMenu data={exportRows as never} columns={exportColumns} filename="achieved-last-12-months" />
            </div>
            <div className="flex flex-wrap gap-3">
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
                  <th className="px-4 py-3 text-left font-semibold">Expires</th>
                  <th className="px-4 py-3 text-left font-semibold">Active</th>
                  <th className="px-4 py-3 text-left font-semibold"></th>
                </tr>
              </thead>
              <GroupedRows
                groups={grouped}
                groupBy={groupBy}
                colSpanTotal={13}
                emptyMessage="No records found from the last 12 months."
                renderRow={(row, idx) => (
                  <tr key={`${row.email}-${row.trainingTitle}-${idx}`} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3">{row.fullName}</td>
                    <td className="px-4 py-3">{row.email}</td>
                    <td className="px-4 py-3">{row.theatre || "-"}</td>
                    <td className="px-4 py-3">{row.region || "-"}</td>
                    <td className="px-4 py-3">{row.country || "-"}</td>
                    <td className="px-4 py-3">{row.trainingTitle}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${row.trainingType === "Certification" ? "bg-blue-100 text-blue-800" : row.trainingType === "Accreditation" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                        {row.trainingType}
                      </span>
                    </td>
                    <td className="px-4 py-3">{row.productType}</td>
                    <td className="px-4 py-3">{row.function}</td>
                    <td className="px-4 py-3">{new Date(row.completedDate).toLocaleDateString()}</td>
                    <td className="px-4 py-3">{new Date(row.expiryDate).toLocaleDateString()}</td>
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
