"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import DateRangePicker, { DateRangeValue, filterByRange } from "@/components/ui/DateRangePicker";
import GroupedRows from "@/components/data-table/GroupedRows";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { useProductTypeColors } from "@/hooks/useProductTypeColors";
import { groupRows, GroupByMode } from "@/lib/group-by";
import { useTableSort, SortAccessor } from "@/hooks/useTableSort";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
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

const TYPES = ["Certification", "Accreditation", "Instructor-Led Training", "OLX"] as const;

function typeBadgeClass(t: string): string {
  if (t === "Certification") return "bg-blue-100 text-blue-800";
  if (t === "Accreditation") return "bg-emerald-100 text-emerald-800";
  if (t === "OLX") return "bg-sky-100 text-sky-800";
  return "bg-amber-100 text-amber-800"; // Instructor-Led Training
}

function ExportMenu({
  data,
  columns,
  filename,
}: {
  data: Record<string, unknown>[];
  columns: { key: string; header: string }[];
  filename: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setShow((p) => !p)}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
      >
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

export default function ByProductTypePage() {
  const router = useRouter();
  const chart = useChartTheme();
  const productColors = useProductTypeColors();
  const companyScope = useCompanyScope();
  const { formatDate } = useDateFormat();
  const { data: recordsData, loading } = useFetchJson<TrainingRecordRow[]>(
    withCompany("/api/reports/training-records", companyScope.selected),
    { enabled: !companyScope.loading }
  );
  const trainingRecords = useMemo(() => recordsData ?? [], [recordsData]);

  const [search, setSearch] = useState("");
  const [filterProduct, setFilterProduct] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterTheatre, setFilterTheatre] = useState("");
  const [dateRange, setDateRange] = useState<DateRangeValue>({ from: null, to: null });
  const [groupBy, setGroupBy] = useState<GroupByMode | null>(null);
  const [countPeople, setCountPeople] = useState(false);

  const products = useMemo(() => [...new Set(trainingRecords.map((r) => r.productType))].filter(Boolean).sort(), [trainingRecords]);
  const types = useMemo(() => [...new Set(trainingRecords.map((r) => r.trainingType))].filter(Boolean).sort(), [trainingRecords]);
  const theatres = useMemo(() => [...new Set(trainingRecords.map((r) => r.theatre))].filter(Boolean).sort(), [trainingRecords]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const dateFiltered = filterByRange(trainingRecords, "completedDate", dateRange);
    return dateFiltered.filter((r) => {
      if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (filterProduct && r.productType !== filterProduct) return false;
      if (filterType && r.trainingType !== filterType) return false;
      if (filterTheatre && r.theatre !== filterTheatre) return false;
      return true;
    });
  }, [trainingRecords, search, filterProduct, filterType, filterTheatre, dateRange]);

  // KPIs. When `countPeople` is on, per-type figures count distinct *active*
  // holders (emails) rather than raw records, so a learner with several certs in
  // the same product type counts once per type. active/expired stay record-based
  // (they power the status donut, which is inherently about record state).
  const kpis = useMemo(() => {
    const activeCount = filtered.filter((r) => r.active).length;
    if (countPeople) {
      const people = (type?: string) => {
        const s = new Set<string>();
        for (const r of filtered) {
          if (!r.active) continue;
          if (type && r.trainingType !== type) continue;
          s.add(r.email);
        }
        return s.size;
      };
      return {
        total: people(),
        cert: people("Certification"),
        accred: people("Accreditation"),
        ilt: people("Instructor-Led Training"),
        olx: people("OLX"),
        active: activeCount,
        expired: filtered.length - activeCount,
      };
    }
    return {
      total: filtered.length,
      cert: filtered.filter((r) => r.trainingType === "Certification").length,
      accred: filtered.filter((r) => r.trainingType === "Accreditation").length,
      ilt: filtered.filter((r) => r.trainingType === "Instructor-Led Training").length,
      olx: filtered.filter((r) => r.trainingType === "OLX").length,
      active: activeCount,
      expired: filtered.length - activeCount,
    };
  }, [filtered, countPeople]);

  // Stacked bar by product. When `countPeople` is on, each cell counts distinct
  // active-holder emails (Set) instead of raw records.
  const productSeries = useMemo(() => {
    type Cell = { name: string; Certification: number; Accreditation: number; "Instructor-Led Training": number; OLX: number };
    if (countPeople) {
      const sets = new Map<string, { name: string; Certification: Set<string>; Accreditation: Set<string>; "Instructor-Led Training": Set<string>; OLX: Set<string> }>();
      for (const r of filtered) {
        if (!r.productType || !r.active) continue;
        const key = r.trainingType as (typeof TYPES)[number];
        if (!TYPES.includes(key)) continue;
        let row = sets.get(r.productType);
        if (!row) {
          row = { name: r.productType, Certification: new Set(), Accreditation: new Set(), "Instructor-Led Training": new Set(), OLX: new Set() };
          sets.set(r.productType, row);
        }
        row[key].add(r.email);
      }
      return Array.from(sets.values())
        .map((row): Cell => ({
          name: row.name,
          Certification: row.Certification.size,
          Accreditation: row.Accreditation.size,
          "Instructor-Led Training": row["Instructor-Led Training"].size,
          OLX: row.OLX.size,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    const m = new Map<string, Cell>();
    for (const r of filtered) {
      if (!r.productType) continue;
      let row = m.get(r.productType);
      if (!row) {
        row = { name: r.productType, Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 };
        m.set(r.productType, row);
      }
      const key = r.trainingType as (typeof TYPES)[number];
      if (TYPES.includes(key)) row[key]++;
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [filtered, countPeople]);

  // Active vs expired donut
  const statusSeries = useMemo(
    () => [
      { name: "Active", value: kpis.active, color: chart.isDark ? "#34d399" : "#10b981" },
      { name: "Expired", value: kpis.expired, color: chart.isDark ? "#f87171" : "#ef4444" },
    ],
    [kpis.active, kpis.expired, chart.isDark]
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

  const grouped = useMemo(
    () => groupRows(sorted, groupBy ?? "theatre"),
    [sorted, groupBy]
  );

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
      <PageHeader title="By Product Type" helpSlug="reports" />

      <KpiStrip
        cards={[
          { label: countPeople ? "People" : "Total Records", value: kpis.total, icon: CircleCheck, tone: "blue" },
          { label: "Certifications", value: kpis.cert, icon: Award, tone: "indigo" },
          { label: "Accreditations", value: kpis.accred, icon: ShieldCheck, tone: "emerald" },
          { label: "ILTs", value: kpis.ilt, icon: GraduationCap, tone: "amber" },
          { label: "OLX", value: kpis.olx, icon: GraduationCap, tone: "blue" },
        ]}
      />

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="lg:col-span-2 bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <h3 className="text-base font-semibold text-gray-900">{countPeople ? "People by Product Type" : "Records by Product Type"}</h3>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-gray-600 select-none">
                <input type="checkbox" checked={countPeople} onChange={(e) => setCountPeople(e.target.checked)} className="rounded border-gray-300" />
                Count people, not records (active holders)
              </label>
              {filterProduct && (
                <button onClick={() => setFilterProduct("")} className="text-xs text-blue-600 hover:underline">Clear product filter</button>
              )}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={productSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis
                dataKey="name"
                stroke={chart.axis}
                tick={(props: { x: string | number; y: string | number; payload: { value: string } }) => {
                  const fill = chart.productColor(props.payload.value, productColors);
                  const x = typeof props.x === "number" ? props.x : Number(props.x);
                  const y = typeof props.y === "number" ? props.y : Number(props.y);
                  return (
                    <text x={x} y={y + 12} textAnchor="middle" fill={fill} fontSize={12} fontWeight={600}>
                      {props.payload.value}
                    </text>
                  );
                }}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Bar dataKey="Certification" stackId="a" fill={chart.typeColor("Certification")} cursor="pointer" onClick={((d: unknown) => { const n = (d as { name?: string }).name; if (n) setFilterProduct(n); }) as never} />
              <Bar dataKey="Accreditation" stackId="a" fill={chart.typeColor("Accreditation")} cursor="pointer" onClick={((d: unknown) => { const n = (d as { name?: string }).name; if (n) setFilterProduct(n); }) as never} />
              <Bar dataKey="Instructor-Led Training" stackId="a" fill={chart.typeColor("Instructor-Led Training")} cursor="pointer" onClick={((d: unknown) => { const n = (d as { name?: string }).name; if (n) setFilterProduct(n); }) as never} />
              <Bar dataKey="OLX" stackId="a" fill={chart.typeColor("OLX")} cursor="pointer" onClick={((d: unknown) => { const n = (d as { name?: string }).name; if (n) setFilterProduct(n); }) as never} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-400 mt-2">Click a bar to filter the table by that product</p>
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
          <p className="text-sm text-gray-500">All training records broken down by product type</p>
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
              <ExportMenu data={exportRows as never} columns={exportColumns} filename="by-product-type" />
            </div>
            <div className="flex flex-wrap gap-3">
              <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Products</option>
                {products.map((p) => <option key={p} value={p}>{p}</option>)}
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
