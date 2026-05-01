"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import DateRangePicker, { DateRangeValue, filterByRange } from "@/components/ui/DateRangePicker";
import GroupedRows from "@/components/data-table/GroupedRows";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { groupRows, GroupByMode } from "@/lib/group-by";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { Search, Download, ArrowLeft, Award, ShieldCheck, GraduationCap, CircleCheck } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
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

export default function ByFunctionPage() {
  const router = useRouter();
  const chart = useChartTheme();
  const companyScope = useCompanyScope();
  const [trainingRecords, setTrainingRecords] = useState<TrainingRecordRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [filterFunction, setFilterFunction] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterTheatre, setFilterTheatre] = useState("");
  const [dateRange, setDateRange] = useState<DateRangeValue>({ from: null, to: null });
  const [groupBy, setGroupBy] = useState<GroupByMode | null>(null);

  useEffect(() => {
    if (companyScope.loading) return;
    setLoading(true);
    fetch(withCompany("/api/reports/training-records", companyScope.selected))
      .then((r) => r.json())
      .then((d) => { setTrainingRecords(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [companyScope.loading, companyScope.selected]);

  const functions = useMemo(() => [...new Set(trainingRecords.map((r) => r.function))].filter(Boolean).sort(), [trainingRecords]);
  const types = useMemo(() => [...new Set(trainingRecords.map((r) => r.trainingType))].filter(Boolean).sort(), [trainingRecords]);
  const theatres = useMemo(() => [...new Set(trainingRecords.map((r) => r.theatre))].filter(Boolean).sort(), [trainingRecords]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const dateFiltered = filterByRange(trainingRecords, "completedDate", dateRange);
    return dateFiltered.filter((r) => {
      if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (filterFunction && r.function !== filterFunction) return false;
      if (filterType && r.trainingType !== filterType) return false;
      if (filterTheatre && r.theatre !== filterTheatre) return false;
      return true;
    });
  }, [trainingRecords, search, filterFunction, filterType, filterTheatre, dateRange]);

  const kpis = useMemo(() => {
    const activeCount = filtered.filter((r) => r.active).length;
    return {
      total: filtered.length,
      cert: filtered.filter((r) => r.trainingType === "Certification").length,
      accred: filtered.filter((r) => r.trainingType === "Accreditation").length,
      ilt: filtered.filter((r) => r.trainingType === "Instructor-Led Training").length,
      active: activeCount,
      expired: filtered.length - activeCount,
    };
  }, [filtered]);

  const functionSeries = useMemo(() => {
    const m = new Map<string, { name: string; Certification: number; Accreditation: number; "Instructor-Led Training": number }>();
    for (const r of filtered) {
      if (!r.function) continue;
      let row = m.get(r.function);
      if (!row) {
        row = { name: r.function, Certification: 0, Accreditation: 0, "Instructor-Led Training": 0 };
        m.set(r.function, row);
      }
      const key = r.trainingType as (typeof TYPES)[number];
      if (TYPES.includes(key)) row[key]++;
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [filtered]);

  const statusSeries = useMemo(
    () => [
      { name: "Active", value: kpis.active, color: chart.isDark ? "#34d399" : "#10b981" },
      { name: "Expired", value: kpis.expired, color: chart.isDark ? "#f87171" : "#ef4444" },
    ],
    [kpis.active, kpis.expired, chart.isDark]
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
      <PageHeader title="By Function" helpSlug="reports" />

      <KpiStrip
        cards={[
          { label: "Total Records", value: kpis.total, icon: CircleCheck, tone: "blue" },
          { label: "Certifications", value: kpis.cert, icon: Award, tone: "indigo" },
          { label: "Accreditations", value: kpis.accred, icon: ShieldCheck, tone: "emerald" },
          { label: "ILTs", value: kpis.ilt, icon: GraduationCap, tone: "amber" },
        ]}
      />

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="lg:col-span-2 bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">Records by Function</h3>
            {filterFunction && (
              <button onClick={() => setFilterFunction("")} className="text-xs text-blue-600 hover:underline">Clear function filter</button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={functionSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Bar dataKey="Certification" stackId="a" fill={chart.typeColor("Certification")} cursor="pointer" onClick={((d: unknown) => { const n = (d as { name?: string }).name; if (n) setFilterFunction(n); }) as never} />
              <Bar dataKey="Accreditation" stackId="a" fill={chart.typeColor("Accreditation")} cursor="pointer" onClick={((d: unknown) => { const n = (d as { name?: string }).name; if (n) setFilterFunction(n); }) as never} />
              <Bar dataKey="Instructor-Led Training" stackId="a" fill={chart.typeColor("Instructor-Led Training")} cursor="pointer" onClick={((d: unknown) => { const n = (d as { name?: string }).name; if (n) setFilterFunction(n); }) as never} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-400 mt-2">Click a bar to filter the table by that function</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Active vs Expired</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={statusSeries} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
                {statusSeries.map((s) => <Cell key={s.name} fill={s.color} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">All training records broken down by function (Sales, Pre-Sales, Deployments)</p>
          <span className="text-sm font-medium text-gray-500">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
              </div>
              <DateRangePicker value={dateRange} onChange={setDateRange} placeholder="Completed date range" />
              <ExportMenu data={exportRows as never} columns={exportColumns} filename="by-function" />
            </div>
            <div className="flex flex-wrap gap-3">
              <select value={filterFunction} onChange={(e) => setFilterFunction(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Functions</option>
                {functions.map((f) => <option key={f} value={f}>{f}</option>)}
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
                emptyMessage="No results match the current filters."
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
                renderSubtotal={(g) => {
                  const active = g.rows.filter((r) => r.active).length;
                  return (
                    <td colSpan={13} className="px-4 py-2">
                      Subtotal — {g.rows.length} record{g.rows.length !== 1 ? "s" : ""} · {active} active · {g.rows.length - active} expired
                    </td>
                  );
                }}
              />
            </table>
          </div>
          {filtered.length > 0 && filtered.length !== trainingRecords.length && (
            <div className="mt-3 text-sm text-gray-500">Showing {filtered.length} of {trainingRecords.length} records</div>
          )}
        </div>
      </div>
    </div>
  );
}
