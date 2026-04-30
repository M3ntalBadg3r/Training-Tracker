"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { ArrowLeft, Download, BookOpen, AlertOctagon, AlertTriangle, TrendingDown } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface CatalogueRow {
  fullTitle: string;
  productType: string;
  trainingType: string;
  function: string;
  totalCompletions: number;
  last12mo: number;
  activeStudents: number;
  expiring90d: number;
  uptakePct: number;
  zeroUptake: boolean;
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

export default function CatalogueHealthPage() {
  const chart = useChartTheme();
  const companyScope = useCompanyScope();
  const [rows, setRows] = useState<CatalogueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterProduct, setFilterProduct] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "zero" | "expiring">("all");

  useEffect(() => {
    if (companyScope.loading) return;
    setLoading(true);
    fetch(withCompany("/api/reports/catalogue-health", companyScope.selected))
      .then((r) => r.json())
      .then((d) => { setRows(d.rows ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [companyScope.loading, companyScope.selected]);

  const products = useMemo(() => [...new Set(rows.map((r) => r.productType))].sort(), [rows]);
  const types = useMemo(() => [...new Set(rows.map((r) => r.trainingType))].sort(), [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (filterProduct && r.productType !== filterProduct) return false;
    if (filterType && r.trainingType !== filterType) return false;
    if (filterStatus === "zero" && !r.zeroUptake) return false;
    if (filterStatus === "expiring" && r.expiring90d === 0) return false;
    return true;
  }), [rows, filterProduct, filterType, filterStatus]);

  const kpis = useMemo(() => ({
    totalTitles: rows.length,
    zeroUptake: rows.filter((r) => r.zeroUptake).length,
    expiring90d: rows.filter((r) => r.expiring90d > 0).length,
    decliningLast12: rows.filter((r) => r.totalCompletions > 0 && r.last12mo === 0).length,
  }), [rows]);

  const topUptake = useMemo(() => filtered.slice().sort((a, b) => b.activeStudents - a.activeStudents).slice(0, 10), [filtered]);
  const topExpiring = useMemo(() => filtered.slice().filter((r) => r.expiring90d > 0).sort((a, b) => b.expiring90d - a.expiring90d).slice(0, 10), [filtered]);

  const exportColumns = [
    { key: "fullTitle", header: "Training" },
    { key: "productType", header: "Product" },
    { key: "trainingType", header: "Type" },
    { key: "function", header: "Function" },
    { key: "totalCompletions", header: "Total Completions" },
    { key: "last12mo", header: "Last 12 Months" },
    { key: "activeStudents", header: "Active Students" },
    { key: "expiring90d", header: "Expiring (90d)" },
    { key: "uptakePct", header: "Uptake %" },
    { key: "zeroUptake", header: "Zero Uptake" },
  ];
  const exportRows = filtered.map((r) => ({ ...r, uptakePct: r.uptakePct.toFixed(1), zeroUptake: r.zeroUptake ? "Yes" : "No" }));

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
      <PageHeader title="Training Catalogue Health" helpSlug="reports-catalogue-health" />

      <KpiStrip
        cards={[
          { label: "Catalogue Titles", value: kpis.totalTitles, icon: BookOpen, tone: "blue" },
          { label: "Zero Completions", value: kpis.zeroUptake, icon: AlertOctagon, tone: "red" },
          { label: "Titles w/ 90d Expiries", value: kpis.expiring90d, icon: AlertTriangle, tone: "amber" },
          { label: "Stale (no 12m completions)", value: kpis.decliningLast12, icon: TrendingDown, tone: "indigo" },
        ]}
      />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Top 10 by Active Students</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topUptake} layout="vertical" margin={{ left: 100 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis type="category" dataKey="fullTitle" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} width={140} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Bar dataKey="activeStudents" fill={chart.series(0)} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Mass-Expiry Risk (90 days)</h3>
          {topExpiring.length === 0 ? (
            <div className="text-sm text-gray-500 py-8 text-center">No titles with active records expiring in the next 90 days.</div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={topExpiring} layout="vertical" margin={{ left: 100 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
                <YAxis type="category" dataKey="fullTitle" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} width={140} />
                <Tooltip contentStyle={tooltipStyle(chart)} />
                <Bar dataKey="expiring90d" fill={chart.series(2)} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">Per-training catalogue uptake, completions, and expiry pressure</p>
          <span className="text-sm font-medium text-gray-500">{filtered.length} title{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-wrap gap-3 mb-4">
            <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">All Products</option>
              {products.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">All Types</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as "all" | "zero" | "expiring")} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="all">All Titles</option>
              <option value="zero">Zero Completions Only</option>
              <option value="expiring">With 90-day Expiries</option>
            </select>
            <ExportMenu data={exportRows as never} columns={exportColumns} filename="catalogue-health" />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold">Training</th>
                  <th className="px-4 py-3 text-left font-semibold">Product</th>
                  <th className="px-4 py-3 text-left font-semibold">Type</th>
                  <th className="px-4 py-3 text-left font-semibold">Function</th>
                  <th className="px-4 py-3 text-right font-semibold">Total</th>
                  <th className="px-4 py-3 text-right font-semibold">Last 12mo</th>
                  <th className="px-4 py-3 text-right font-semibold">Active</th>
                  <th className="px-4 py-3 text-right font-semibold">Expiring 90d</th>
                  <th className="px-4 py-3 text-right font-semibold">Uptake</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={`${r.fullTitle}-${i}`} className={`border-b hover:bg-gray-50 ${r.zeroUptake ? "bg-red-50" : ""}`}>
                    <td className="px-4 py-3">{r.fullTitle}</td>
                    <td className="px-4 py-3">{r.productType}</td>
                    <td className="px-4 py-3">{r.trainingType}</td>
                    <td className="px-4 py-3">{r.function}</td>
                    <td className="px-4 py-3 text-right">{r.totalCompletions}</td>
                    <td className="px-4 py-3 text-right">{r.last12mo}</td>
                    <td className="px-4 py-3 text-right">{r.activeStudents}</td>
                    <td className="px-4 py-3 text-right">{r.expiring90d}</td>
                    <td className="px-4 py-3 text-right">{r.uptakePct.toFixed(1)}%</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-500">No titles match the current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
