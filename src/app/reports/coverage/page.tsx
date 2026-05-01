"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { GroupByMode } from "@/lib/group-by";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { ArrowLeft, Download, Globe, Users, ShieldCheck, Target } from "lucide-react";
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

interface CoverageRow {
  bucket: string;
  product: string;
  trainingType: string;
  attained: number;
  totalInBucket: number;
  coveragePct: number;
}

interface CoverageResponse {
  rows: CoverageRow[];
  buckets: string[];
  totalStudents: number;
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

export default function CoveragePage() {
  const chart = useChartTheme();
  const companyScope = useCompanyScope();
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupByMode>("theatre");
  const [filterProduct, setFilterProduct] = useState("");
  const [filterType, setFilterType] = useState("");

  useEffect(() => {
    if (companyScope.loading) return;
    setLoading(true);
    fetch(withCompany(`/api/reports/coverage?groupBy=${groupBy}`, companyScope.selected))
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [groupBy, companyScope.loading, companyScope.selected]);

  const products = useMemo(() => [...new Set(data?.rows.map((r) => r.product) ?? [])].sort(), [data]);
  const types = useMemo(() => [...new Set(data?.rows.map((r) => r.trainingType) ?? [])].sort(), [data]);

  const filteredRows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => {
      if (filterProduct && r.product !== filterProduct) return false;
      if (filterType && r.trainingType !== filterType) return false;
      return true;
    });
  }, [data, filterProduct, filterType]);

  // Bar chart: bucket × product (one stacked bar per bucket with a series per product)
  const bucketChart = useMemo(() => {
    if (!data) return { rows: [], products: [] };
    const usableProducts = filterProduct ? [filterProduct] : products;
    const bucketRowMap = new Map<string, Record<string, string | number>>();
    for (const b of data.buckets) bucketRowMap.set(b, { name: b });
    for (const r of filteredRows) {
      if (filterType && r.trainingType !== filterType) continue;
      if (filterProduct && r.product !== filterProduct) continue;
      const row = bucketRowMap.get(r.bucket);
      if (!row) continue;
      row[r.product] = ((row[r.product] as number) ?? 0) + r.attained;
    }
    return {
      rows: Array.from(bucketRowMap.values()),
      products: usableProducts,
    };
  }, [data, filteredRows, products, filterProduct, filterType]);

  const overallCoverage = useMemo(() => {
    if (!filteredRows.length || !data) return 0;
    const attainedEmails = filteredRows.reduce((s, r) => s + r.attained, 0);
    const totalDenom = filteredRows.reduce((s, r) => s + r.totalInBucket, 0);
    return totalDenom === 0 ? 0 : (attainedEmails / totalDenom) * 100;
  }, [filteredRows, data]);

  const exportColumns = [
    { key: "bucket", header: groupBy.charAt(0).toUpperCase() + groupBy.slice(1) },
    { key: "product", header: "Product" },
    { key: "trainingType", header: "Type" },
    { key: "attained", header: "Attained" },
    { key: "totalInBucket", header: "Total Students" },
    { key: "coveragePct", header: "Coverage %" },
  ];
  const exportRows = filteredRows.map((r) => ({
    ...r,
    coveragePct: r.coveragePct.toFixed(1),
  }));

  if (loading || !data) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>;
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Reports
        </Link>
      </div>
      <PageHeader title="Coverage / Compliance" helpSlug="reports-coverage" />

      <KpiStrip
        cards={[
          { label: "Overall Coverage", value: `${overallCoverage.toFixed(1)}%`, icon: Target, tone: "blue" },
          { label: "Total Students", value: data.totalStudents, icon: Users, tone: "indigo" },
          { label: "Buckets in Scope", value: data.buckets.length, icon: Globe, tone: "emerald" },
          { label: "Coverage Rows", value: filteredRows.length, icon: ShieldCheck, tone: "amber" },
        ]}
      />

      <section className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 className="text-base font-semibold text-gray-900 mb-4">Active Trainings by {groupBy}</h3>
        <ResponsiveContainer width="100%" height={350}>
          <BarChart data={bucketChart.rows}>
            <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-30} textAnchor="end" height={80} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
            <Tooltip contentStyle={tooltipStyle(chart)} />
            <Legend />
            {bucketChart.products.map((p, i) => (
              <Bar key={p} dataKey={p} stackId="a" fill={chart.series(i)} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">Active training holders per {groupBy} bucket as a share of bucket population</p>
          <span className="text-sm font-medium text-gray-500">{filteredRows.length} row{filteredRows.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-wrap gap-3 mb-4">
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupByMode)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="theatre">Group by Theatre</option>
              <option value="region">Group by Region</option>
              <option value="country">Group by Country</option>
            </select>
            <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">All Products</option>
              {products.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">All Types</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <ExportMenu data={exportRows as never} columns={exportColumns} filename="coverage" />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold capitalize">{groupBy}</th>
                  <th className="px-4 py-3 text-left font-semibold">Product</th>
                  <th className="px-4 py-3 text-left font-semibold">Type</th>
                  <th className="px-4 py-3 text-right font-semibold">Attained</th>
                  <th className="px-4 py-3 text-right font-semibold">Bucket Population</th>
                  <th className="px-4 py-3 text-right font-semibold">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r, i) => (
                  <tr key={`${r.bucket}-${r.product}-${r.trainingType}-${i}`} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3">{r.bucket}</td>
                    <td className="px-4 py-3">{r.product}</td>
                    <td className="px-4 py-3">{r.trainingType}</td>
                    <td className="px-4 py-3 text-right">{r.attained}</td>
                    <td className="px-4 py-3 text-right">{r.totalInBucket}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`inline-block px-2 py-0.5 rounded font-medium ${r.coveragePct >= 80 ? "bg-green-100 text-green-800" : r.coveragePct >= 40 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"}`}>
                        {r.coveragePct.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
                {filteredRows.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No coverage data for the current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
