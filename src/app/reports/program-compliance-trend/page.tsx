"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { ArrowLeft, Download, TrendingUp, ShieldCheck, Award, BarChart3 } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface Snapshot {
  program: string;
  specialisation: string;
  monthKey: string;
  monthLabel: string;
  attained: number;
  required: number;
  compliancePct: number;
}

interface TrendResponse {
  snapshots: Snapshot[];
  programs: string[];
  specialisations: string[];
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

export default function ProgramComplianceTrendPage() {
  const chart = useChartTheme();
  const [data, setData] = useState<TrendResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [program, setProgram] = useState("");

  useEffect(() => {
    setLoading(true);
    const url = program ? `/api/reports/program-compliance-trend?program=${encodeURIComponent(program)}` : "/api/reports/program-compliance-trend";
    fetch(url)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [program]);

  // Pivot snapshots: one row per month, one column per specialisation (filtered by selected program if any)
  const chartData = useMemo(() => {
    if (!data) return [];
    const months = new Map<string, Record<string, string | number>>();
    for (const s of data.snapshots) {
      let row = months.get(s.monthKey);
      if (!row) {
        row = { monthLabel: s.monthLabel, monthKey: s.monthKey };
        months.set(s.monthKey, row);
      }
      const colKey = data.programs.length > 1 ? `${s.program} — ${s.specialisation}` : s.specialisation;
      row[colKey] = Math.round(s.compliancePct);
    }
    return Array.from(months.values()).sort((a, b) => String(a.monthKey).localeCompare(String(b.monthKey)));
  }, [data]);

  const seriesKeys = useMemo(() => {
    if (!data || chartData.length === 0) return [] as string[];
    const last = chartData[chartData.length - 1];
    return Object.keys(last).filter((k) => k !== "monthLabel" && k !== "monthKey");
  }, [data, chartData]);

  const kpis = useMemo(() => {
    if (!data) return { latest: 0, deltaPp: 0, specsTracked: 0, snapshots: 0 };
    const latestMonth = chartData[chartData.length - 1];
    const earliestMonth = chartData[0];
    const avg = (row: Record<string, string | number> | undefined) => {
      if (!row) return 0;
      const vals = Object.entries(row).filter(([k]) => k !== "monthLabel" && k !== "monthKey").map(([, v]) => Number(v));
      return vals.length === 0 ? 0 : vals.reduce((s, v) => s + v, 0) / vals.length;
    };
    const latest = avg(latestMonth);
    const earliest = avg(earliestMonth);
    return {
      latest: Math.round(latest),
      deltaPp: Math.round(latest - earliest),
      specsTracked: seriesKeys.length,
      snapshots: data.snapshots.length,
    };
  }, [data, chartData, seriesKeys]);

  const exportColumns = [
    { key: "program", header: "Program" },
    { key: "specialisation", header: "Specialisation" },
    { key: "monthLabel", header: "Month" },
    { key: "attained", header: "Attained" },
    { key: "required", header: "Required" },
    { key: "compliancePct", header: "Compliance %" },
  ];
  const exportRows = (data?.snapshots ?? []).map((s) => ({ ...s, compliancePct: s.compliancePct.toFixed(1) }));

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
      <PageHeader title="Program Compliance Trend" helpSlug="reports-program-compliance-trend" />

      <KpiStrip
        cards={[
          { label: "Latest Compliance (avg)", value: `${kpis.latest}%`, icon: ShieldCheck, tone: "blue" },
          { label: "12-mo Δ (pp)", value: `${kpis.deltaPp >= 0 ? "+" : ""}${kpis.deltaPp}`, icon: TrendingUp, tone: kpis.deltaPp >= 0 ? "emerald" : "red" },
          { label: "Specialisations Tracked", value: kpis.specsTracked, icon: Award, tone: "indigo" },
          { label: "Snapshots", value: kpis.snapshots, icon: BarChart3, tone: "amber" },
        ]}
      />

      <section className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900">Compliance % by Specialisation, Last 12 Months</h3>
          <div className="flex gap-2 items-center">
            <select value={program} onChange={(e) => setProgram(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
              <option value="">All Programs</option>
              {data.programs.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <ExportMenu data={exportRows as never} columns={exportColumns} filename="program-compliance-trend" />
          </div>
        </div>
        <ResponsiveContainer width="100%" height={350}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
            <XAxis dataKey="monthLabel" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={50} />
            <YAxis allowDecimals={false} domain={[0, 100]} unit="%" tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
            <Tooltip contentStyle={tooltipStyle(chart)} />
            <Legend />
            {seriesKeys.map((k, i) => (
              <Line key={k} type="monotone" dataKey={k} stroke={chart.series(i)} strokeWidth={2} dot={{ r: 2 }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
        {seriesKeys.length === 0 && (
          <div className="text-sm text-gray-500 mt-4 text-center">No program compliance data — set up specialisations and program data in Admin first.</div>
        )}
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <p className="text-sm text-gray-500">Raw monthly snapshots (attained vs required) per specialisation</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="px-4 py-3 text-left font-semibold">Program</th>
                <th className="px-4 py-3 text-left font-semibold">Specialisation</th>
                <th className="px-4 py-3 text-left font-semibold">Month</th>
                <th className="px-4 py-3 text-right font-semibold">Attained</th>
                <th className="px-4 py-3 text-right font-semibold">Required</th>
                <th className="px-4 py-3 text-right font-semibold">Compliance</th>
              </tr>
            </thead>
            <tbody>
              {data.snapshots.map((s, i) => (
                <tr key={`${s.program}-${s.specialisation}-${s.monthKey}-${i}`} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-3">{s.program}</td>
                  <td className="px-4 py-3">{s.specialisation}</td>
                  <td className="px-4 py-3">{s.monthLabel}</td>
                  <td className="px-4 py-3 text-right">{s.attained}</td>
                  <td className="px-4 py-3 text-right">{s.required}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`inline-block px-2 py-0.5 rounded font-medium ${s.compliancePct >= 80 ? "bg-green-100 text-green-800" : s.compliancePct >= 40 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"}`}>
                      {s.compliancePct.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
              {data.snapshots.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No snapshots available.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
