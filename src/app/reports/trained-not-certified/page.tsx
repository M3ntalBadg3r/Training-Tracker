"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import GroupedRows from "@/components/data-table/GroupedRows";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { useProductTypeColors } from "@/hooks/useProductTypeColors";
import { groupRows, GroupByMode, resolveBucket } from "@/lib/group-by";
import { useTableSort, SortAccessor } from "@/hooks/useTableSort";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import { Search, Download, ArrowLeft, AlertCircle, Award, GraduationCap, Users } from "lucide-react";
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

interface TrainedNotCertifiedRow {
  fullName: string;
  email: string;
  theatre: string;
  region: string;
  country: string;
  iltFullTitle: string;
  iltProductType: string;
  certificationFullTitle: string;
  iltCompletedDate: string;
  iltActive: boolean;
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

export default function TrainedNotCertifiedPage() {
  const router = useRouter();
  const chart = useChartTheme();
  const productColors = useProductTypeColors();
  const { formatDate } = useDateFormat();
  const companyScope = useCompanyScope();
  const { data: reportRaw, loading } = useFetchJson<TrainedNotCertifiedRow[]>(
    withCompany("/api/reports/trained-not-certified", companyScope.selected),
    { enabled: !companyScope.loading }
  );
  const reportData = useMemo(() => reportRaw ?? [], [reportRaw]);

  const [searchQuery, setSearchQuery] = useState("");
  const [filterTheatre, setFilterTheatre] = useState("");
  const [filterRegion, setFilterRegion] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [filterProduct, setFilterProduct] = useState("");
  const [filterIlt, setFilterIlt] = useState("");
  const [filterCert, setFilterCert] = useState("");
  const [filterActive, setFilterActive] = useState("");
  const [groupBy, setGroupBy] = useState<GroupByMode | null>("theatre");

  const theatres = useMemo(() => [...new Set(reportData.map((r) => r.theatre))].filter(Boolean).sort(), [reportData]);
  const regions = useMemo(() => [...new Set(reportData.map((r) => r.region))].filter(Boolean).sort(), [reportData]);
  const countries = useMemo(() => [...new Set(reportData.map((r) => r.country))].filter(Boolean).sort(), [reportData]);
  const productTypes = useMemo(() => [...new Set(reportData.map((r) => r.iltProductType))].filter(Boolean).sort(), [reportData]);
  const iltTitles = useMemo(() => [...new Set(reportData.map((r) => r.iltFullTitle))].sort(), [reportData]);
  // A row's certificationFullTitle may hold several alternative certs joined
  // with " or " — list each one individually in the filter dropdown.
  const certTitles = useMemo(() => [...new Set(reportData.flatMap((r) => r.certificationFullTitle.split(" or ")))].filter(Boolean).sort(), [reportData]);

  const filteredData = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return reportData.filter((r) => {
      const matchesSearch = !searchQuery || r.fullName.toLowerCase().includes(q) || r.email.toLowerCase().includes(q);
      const matchesTheatre = !filterTheatre || r.theatre === filterTheatre;
      const matchesRegion = !filterRegion || r.region === filterRegion;
      const matchesCountry = !filterCountry || r.country === filterCountry;
      const matchesProduct = !filterProduct || r.iltProductType === filterProduct;
      const matchesIlt = !filterIlt || r.iltFullTitle === filterIlt;
      const matchesCert = !filterCert || r.certificationFullTitle.split(" or ").includes(filterCert);
      const matchesActive = !filterActive || (filterActive === "yes" ? r.iltActive : !r.iltActive);
      return matchesSearch && matchesTheatre && matchesRegion && matchesCountry && matchesProduct && matchesIlt && matchesCert && matchesActive;
    });
  }, [reportData, searchQuery, filterTheatre, filterRegion, filterCountry, filterProduct, filterIlt, filterCert, filterActive]);

  // Funnel-style chart by product: ILT-only count + active-ILT count
  const productSeries = useMemo(() => {
    const m = new Map<string, { name: string; "ILT Completed": number; "ILT Still Active": number }>();
    for (const r of filteredData) {
      let row = m.get(r.iltProductType);
      if (!row) {
        row = { name: r.iltProductType, "ILT Completed": 0, "ILT Still Active": 0 };
        m.set(r.iltProductType, row);
      }
      row["ILT Completed"]++;
      if (r.iltActive) row["ILT Still Active"]++;
    }
    return Array.from(m.values()).sort((a, b) => b["ILT Completed"] - a["ILT Completed"]);
  }, [filteredData]);

  const bucketSeries = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of filteredData) {
      const k = resolveBucket(r, groupBy ?? "theatre");
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return Array.from(m.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [filteredData, groupBy]);

  const kpis = useMemo(() => {
    const activeIlt = filteredData.filter((r) => r.iltActive).length;
    const distinctStudents = new Set(filteredData.map((r) => r.email)).size;
    const distinctIlts = new Set(filteredData.map((r) => r.iltFullTitle)).size;
    return {
      total: filteredData.length,
      activeIlt,
      distinctStudents,
      distinctIlts,
    };
  }, [filteredData]);

  // Column sorting (applied before grouping so rows sort within each group).
  const sortAccessors: Record<string, SortAccessor<TrainedNotCertifiedRow>> = {
    fullName: (r) => r.fullName,
    email: (r) => r.email,
    theatre: (r) => r.theatre,
    region: (r) => r.region,
    country: (r) => r.country,
    iltFullTitle: (r) => r.iltFullTitle,
    iltProductType: (r) => r.iltProductType,
    iltCompletedDate: (r) => r.iltCompletedDate,
    iltActive: (r) => r.iltActive,
    certificationFullTitle: (r) => r.certificationFullTitle,
  };
  const { sorted, toggleSort, sortIndicator } = useTableSort(filteredData, sortAccessors, {
    defaultKey: "fullName",
    tiebreakKey: "fullName",
  });

  const grouped = useMemo(() => groupRows(sorted, groupBy ?? "theatre"), [sorted, groupBy]);

  const exportColumns = [
    { key: "fullName", header: "Full Name" },
    { key: "email", header: "Email Address" },
    { key: "theatre", header: "Theatre" },
    { key: "region", header: "Region" },
    { key: "country", header: "Country" },
    { key: "iltFullTitle", header: "Instructor-Led Training" },
    { key: "iltProductType", header: "Product" },
    { key: "iltCompletedDate", header: "ILT Completed Date" },
    { key: "iltActive", header: "ILT Active" },
    { key: "certificationFullTitle", header: "Certification Not Obtained" },
  ];
  const exportRows = filteredData.map((r) => ({
    ...r,
    iltCompletedDate: formatDate(r.iltCompletedDate),
    iltActive: r.iltActive ? "Yes" : "No",
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
      <PageHeader title="Trained But Not Certified" helpSlug="reports" />

      <KpiStrip
        cards={[
          { label: "Gaps (ILT → Cert)", value: kpis.total, icon: AlertCircle, tone: "red" },
          { label: "Distinct Students", value: kpis.distinctStudents, icon: Users, tone: "blue" },
          { label: "Distinct ILTs", value: kpis.distinctIlts, icon: GraduationCap, tone: "amber" },
          { label: "ILT Still Active", value: kpis.activeIlt, icon: Award, tone: "emerald" },
        ]}
      />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">Gap by Product (ILT → Cert)</h3>
            {filterProduct && (
              <button onClick={() => setFilterProduct("")} className="text-xs text-blue-600 hover:underline">Clear product filter</button>
            )}
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
              <Bar dataKey="ILT Completed" fill={chart.typeColor("Instructor-Led Training")} cursor="pointer" onClick={((d: unknown) => { const n = (d as { name?: string }).name; if (n) setFilterProduct(n); }) as never} />
              <Bar dataKey="ILT Still Active" fill={chart.typeColor("Certification")} cursor="pointer" onClick={((d: unknown) => { const n = (d as { name?: string }).name; if (n) setFilterProduct(n); }) as never} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-400 mt-2">Click a bar to filter the table by that product</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Top {groupBy ?? "theatre"}s with Gaps</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={bucketSeries} layout="vertical" margin={{ left: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} width={100} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Bar dataKey="count" fill={chart.series(0)} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">Students who completed an Instructor-Led Training but haven&apos;t obtained the associated Certification</p>
          <span className="text-sm font-medium text-gray-500">{reportData.length} result{reportData.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" placeholder="Search by name or email..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
              </div>
              <ExportMenu data={exportRows as never} columns={exportColumns} filename="trained-not-certified" />
            </div>
            <div className="flex flex-wrap gap-3">
              <select value={filterTheatre} onChange={(e) => setFilterTheatre(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Theatres</option>
                {theatres.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={filterRegion} onChange={(e) => setFilterRegion(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Regions</option>
                {regions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <select value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Countries</option>
                {countries.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Products</option>
                {productTypes.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select value={filterIlt} onChange={(e) => setFilterIlt(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Trainings</option>
                {iltTitles.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={filterCert} onChange={(e) => setFilterCert(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Certifications</option>
                {certTitles.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={filterActive} onChange={(e) => setFilterActive(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Active Status</option>
                <option value="yes">Active</option>
                <option value="no">Not Active</option>
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
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("email")}>Email Address{sortIndicator("email")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("theatre")}>Theatre{sortIndicator("theatre")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("region")}>Region{sortIndicator("region")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("country")}>Country{sortIndicator("country")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("iltFullTitle")}>Instructor-Led Training{sortIndicator("iltFullTitle")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("iltProductType")}>Product{sortIndicator("iltProductType")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("iltCompletedDate")}>ILT Completed Date{sortIndicator("iltCompletedDate")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("iltActive")}>ILT Active{sortIndicator("iltActive")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("certificationFullTitle")}>Certification Not Obtained{sortIndicator("certificationFullTitle")}</th>
                  <th className="px-4 py-3 text-left font-semibold"></th>
                </tr>
              </thead>
              <GroupedRows
                groups={grouped}
                groupBy={groupBy}
                colSpanTotal={11}
                emptyMessage={reportData.length === 0 ? "No results found. Ensure ILT trainings have certification mappings in Training Data." : "No results match the current filters."}
                renderRow={(row, idx) => (
                  <tr key={`${row.email}-${row.iltFullTitle}-${idx}`} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3">{row.fullName}</td>
                    <td className="px-4 py-3">{row.email}</td>
                    <td className="px-4 py-3">{row.theatre || "-"}</td>
                    <td className="px-4 py-3">{row.region || "-"}</td>
                    <td className="px-4 py-3">{row.country || "-"}</td>
                    <td className="px-4 py-3">{row.iltFullTitle}</td>
                    <td className="px-4 py-3">{row.iltProductType}</td>
                    <td className="px-4 py-3">{formatDate(row.iltCompletedDate)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${row.iltActive ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
                        {row.iltActive ? "Yes" : "No"}
                      </span>
                    </td>
                    <td className="px-4 py-3">{row.certificationFullTitle}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => router.push(`/students/${encodeURIComponent(row.email)}`)} className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors">View</button>
                    </td>
                  </tr>
                )}
                renderSubtotal={(g) => {
                  const active = g.rows.filter((r) => r.iltActive).length;
                  return (
                    <td colSpan={11} className="px-4 py-2">
                      Subtotal — {g.rows.length} gap{g.rows.length !== 1 ? "s" : ""} · {active} ILT still active
                    </td>
                  );
                }}
              />
            </table>
          </div>

          {filteredData.length > 0 && filteredData.length !== reportData.length && (
            <div className="mt-3 text-sm text-gray-500">Showing {filteredData.length} of {reportData.length} results</div>
          )}
        </div>
      </div>
    </div>
  );
}
