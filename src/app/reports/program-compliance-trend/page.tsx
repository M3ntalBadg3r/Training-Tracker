"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { ArrowLeft, Download, TrendingUp, ShieldCheck, Award, BarChart3 } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
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
  projected: boolean;
}

interface TrendResponse {
  snapshots: Snapshot[];
  programs: string[];
  specialisations: string[];
  scopeLabel: string;
}

interface RegionRow {
  country: string;
  region: string;
  theatre: string | null;
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
  const companyScope = useCompanyScope();
  const [data, setData] = useState<TrendResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [program, setProgram] = useState("");
  const [regionRows, setRegionRows] = useState<RegionRow[]>([]);
  const [theatre, setTheatre] = useState("");
  const [region, setRegion] = useState("");
  const [country, setCountry] = useState("");

  // Region data (theatre/region/country) for the scope filters — global, not company-scoped.
  useEffect(() => {
    fetch("/api/region-data/countries")
      .then((r) => r.json())
      .then((rows: RegionRow[]) => setRegionRows(Array.isArray(rows) ? rows : []))
      .catch(() => setRegionRows([]));
  }, []);

  useEffect(() => {
    if (companyScope.loading) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (program) params.set("program", program);
    if (country) params.set("country", country);
    else if (region) params.set("region", region);
    else if (theatre) params.set("theatre", theatre);
    const qs = params.toString();
    const base = `/api/reports/program-compliance-trend${qs ? `?${qs}` : ""}`;
    fetch(withCompany(base, companyScope.selected))
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [program, theatre, region, country, companyScope.loading, companyScope.selected]);

  // Cascading filter option lists (theatre → region → country).
  const theatreOptions = useMemo(
    () => [...new Set(regionRows.map((r) => r.theatre).filter((t): t is string => !!t))].sort(),
    [regionRows]
  );
  const regionOptions = useMemo(
    () => [...new Set(regionRows.filter((r) => !theatre || r.theatre === theatre).map((r) => r.region).filter(Boolean))].sort(),
    [regionRows, theatre]
  );
  const countryOptions = useMemo(
    () => [...new Set(regionRows
      .filter((r) => (!theatre || r.theatre === theatre) && (!region || r.region === region))
      .map((r) => r.country))].sort(),
    [regionRows, theatre, region]
  );

  // The latest non-projected month is "now"; everything after it is forecast.
  const nowMonthKey = useMemo(() => {
    if (!data) return null;
    let k: string | null = null;
    for (const s of data.snapshots) if (!s.projected && (k === null || s.monthKey > k)) k = s.monthKey;
    return k;
  }, [data]);

  // Pivot snapshots into one row per month. Each specialisation produces a solid
  // series (history, up to & incl. now) and a dashed `__forecast` series (now →
  // +12), sharing the "now" point so the dashed segment joins the solid line.
  const { chartData, seriesKeys } = useMemo(() => {
    if (!data || data.snapshots.length === 0) return { chartData: [] as Record<string, string | number | boolean>[], seriesKeys: [] as string[] };
    const colOf = (s: Snapshot) => (data.programs.length > 1 ? `${s.program} — ${s.specialisation}` : s.specialisation);
    const cols = [...new Set(data.snapshots.map(colOf))].sort();
    const months = new Map<string, Record<string, string | number | boolean>>();
    for (const s of data.snapshots) {
      let row = months.get(s.monthKey);
      if (!row) {
        row = { monthLabel: s.monthLabel, monthKey: s.monthKey, projected: s.projected };
        months.set(s.monthKey, row);
      }
      const col = colOf(s);
      const val = Math.round(s.compliancePct);
      if (s.projected) {
        row[`${col}__forecast`] = val;
      } else {
        row[col] = val;
        if (s.monthKey === nowMonthKey) row[`${col}__forecast`] = val;
      }
    }
    const chartData = Array.from(months.values()).sort((a, b) => String(a.monthKey).localeCompare(String(b.monthKey)));
    return { chartData, seriesKeys: cols };
  }, [data, nowMonthKey]);

  const nowMonthLabel = useMemo(
    () => String(chartData.find((r) => r.monthKey === nowMonthKey)?.monthLabel ?? ""),
    [chartData, nowMonthKey]
  );

  const kpis = useMemo(() => {
    if (!data) return { current: 0, forecastDelta: 0, specsTracked: 0, snapshots: 0 };
    const nowRow = chartData.find((r) => r.monthKey === nowMonthKey);
    const lastRow = chartData[chartData.length - 1];
    const avg = (row: Record<string, string | number | boolean> | undefined, keys: string[]) => {
      if (!row) return 0;
      const vals = keys.map((k) => Number(row[k])).filter((v) => !Number.isNaN(v));
      return vals.length === 0 ? 0 : vals.reduce((s, v) => s + v, 0) / vals.length;
    };
    const current = avg(nowRow, seriesKeys);
    const forecast = avg(lastRow, seriesKeys.map((k) => `${k}__forecast`));
    return {
      current: Math.round(current),
      forecastDelta: Math.round(forecast - current),
      specsTracked: seriesKeys.length,
      snapshots: data.snapshots.length,
    };
  }, [data, chartData, seriesKeys, nowMonthKey]);

  const exportColumns = [
    { key: "program", header: "Program" },
    { key: "specialisation", header: "Specialisation" },
    { key: "monthLabel", header: "Month" },
    { key: "attained", header: "Attained" },
    { key: "required", header: "Required" },
    { key: "compliancePct", header: "Compliance %" },
    { key: "projected", header: "Projected" },
  ];
  const exportRows = (data?.snapshots ?? []).map((s) => ({ ...s, compliancePct: s.compliancePct.toFixed(1), projected: s.projected ? "Yes" : "No" }));

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
          { label: "Current Compliance (avg)", value: `${kpis.current}%`, icon: ShieldCheck, tone: "blue" },
          { label: "Forecast 12-mo Δ (pp)", value: `${kpis.forecastDelta >= 0 ? "+" : ""}${kpis.forecastDelta}`, icon: TrendingUp, tone: kpis.forecastDelta >= 0 ? "emerald" : "red" },
          { label: "Specialisations Tracked", value: kpis.specsTracked, icon: Award, tone: "indigo" },
          { label: "Snapshots", value: kpis.snapshots, icon: BarChart3, tone: "amber" },
        ]}
      />

      <section className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <div className="flex items-start justify-between mb-1 gap-4 flex-wrap">
          <h3 className="text-base font-semibold text-gray-900">Compliance % by Specialisation — 12-Month History &amp; Forecast</h3>
          <div className="flex gap-2 items-center flex-wrap">
            <select value={program} onChange={(e) => setProgram(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
              <option value="">All Programs</option>
              {data.programs.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={theatre} onChange={(e) => { setTheatre(e.target.value); setRegion(""); setCountry(""); }} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
              <option value="">All Theatres</option>
              {theatreOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={region} onChange={(e) => { setRegion(e.target.value); setCountry(""); }} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
              <option value="">All Regions</option>
              {regionOptions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select value={country} onChange={(e) => setCountry(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
              <option value="">All Countries</option>
              {countryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <ExportMenu data={exportRows as never} columns={exportColumns} filename="program-compliance-trend" />
          </div>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Showing: <span className="font-medium text-gray-700">{data.scopeLabel}</span> · scoped to the company selected above. Solid = history, dashed = forecast (assumes no new completions — only existing certifications expiring).
        </p>
        <ResponsiveContainer width="100%" height={350}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
            <XAxis dataKey="monthLabel" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={50} />
            <YAxis allowDecimals={false} domain={[0, 100]} unit="%" tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
            <Tooltip contentStyle={tooltipStyle(chart)} />
            <Legend />
            {nowMonthLabel && (
              <ReferenceLine x={nowMonthLabel} stroke={chart.axis} strokeDasharray="4 4" label={{ value: "Forecast →", position: "top", fill: chart.axis, fontSize: 11 }} />
            )}
            {seriesKeys.map((k, i) => (
              <Line key={k} name={k} type="monotone" dataKey={k} stroke={chart.series(i)} strokeWidth={2} dot={{ r: 2 }} connectNulls={false} />
            ))}
            {seriesKeys.map((k, i) => (
              <Line key={`${k}__forecast`} name={`${k} (forecast)`} legendType="none" type="monotone" dataKey={`${k}__forecast`} stroke={chart.series(i)} strokeWidth={2} strokeDasharray="6 4" dot={{ r: 2 }} connectNulls={false} />
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
                <th className="px-4 py-3 text-left font-semibold">Type</th>
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
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${s.projected ? "bg-indigo-100 text-indigo-800" : "bg-gray-100 text-gray-700"}`}>
                      {s.projected ? "Forecast" : "History"}
                    </span>
                  </td>
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
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No snapshots available.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
