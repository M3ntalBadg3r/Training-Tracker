"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import FilterBar from "@/components/ui/FilterBar";
import { SELECT_CLASS } from "@/components/ui/FormControls";
import LoadingState from "@/components/ui/LoadingState";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { useTableSort, SortAccessor } from "@/hooks/useTableSort";
import { exportToCsv, exportToExcel } from "@/lib/export";
import { exportReportTablePdf } from "@/lib/report-export";
import ExportMenu, { type ExportFormat } from "@/components/ui/ExportMenu";
import { ExportableChart, useChartCapture } from "@/components/reports/ChartCaptureProvider";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useRegionData } from "@/hooks/useRegionData";
import { TrendingUp, ShieldCheck, Award, BarChart3 } from "lucide-react";
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


function ProgramComplianceTrendPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const chart = useChartTheme();
  const companyScope = useCompanyScope();
  // Seeded from the URL so a reload or a shared link reopens the same view.
  const [program, setProgram] = useState(() => searchParams.get("program") ?? "");
  const { rows: regionRows } = useRegionData();
  const [theatre, setTheatre] = useState(() => searchParams.get("theatre") ?? "");
  const [region, setRegion] = useState(() => searchParams.get("region") ?? "");
  const [country, setCountry] = useState(() => searchParams.get("country") ?? "");

  // Read once: useTableSort seeds its own state from these, and holding the
  // snapshot keeps the mirror effect's rewrites from feeding back in.
  const [urlSort] = useState(() => ({
    key: searchParams.get("sort") ?? "",
    dir: searchParams.get("sortDir") === "desc" ? ("desc" as const) : ("asc" as const),
  }));

  const trendUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (program) params.set("program", program);
    if (country) params.set("country", country);
    else if (region) params.set("region", region);
    else if (theatre) params.set("theatre", theatre);
    const qs = params.toString();
    const base = `/api/reports/program-compliance-trend${qs ? `?${qs}` : ""}`;
    return withCompany(base, companyScope.selected);
  }, [program, country, region, theatre, companyScope.selected]);
  const { data, loading } = useFetchJson<TrendResponse>(trendUrl, { enabled: !companyScope.loading });

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

  // Column sorting for the raw snapshots table. Month sorts chronologically by
  // monthKey (not the display label). Called unconditionally before the early
  // return below to satisfy the rules of hooks.
  const snapshotSortAccessors: Record<string, SortAccessor<Snapshot>> = {
    program: (s) => s.program,
    specialisation: (s) => s.specialisation,
    monthKey: (s) => s.monthKey,
    projected: (s) => s.projected,
    attained: (s) => s.attained,
    required: (s) => s.required,
    compliancePct: (s) => s.compliancePct,
  };
  const { sorted: sortedSnapshots, sortKey, sortDir, toggleSort, sortIndicator } = useTableSort(
    data?.snapshots ?? [],
    snapshotSortAccessors,
    {
      // A seeded key naming no column would leave the table silently unsorted.
      // `Object.hasOwn`, not `in`: `?sort=constructor` satisfies `in` via the
      // prototype and would hand the sorter the Object constructor as an accessor.
      defaultKey: Object.hasOwn(snapshotSortAccessors, urlSort.key) ? urlSort.key : "monthKey",
      defaultDir: urlSort.dir,
      tiebreakKey: "specialisation",
      descFirstKeys: ["attained", "required", "compliancePct"],
    },
  );

  // Mirror the view to the URL so a reload, a bookmark or Back restores it.
  const buildViewParams = useCallback(() => {
    const params = new URLSearchParams();
    if (program) params.set("program", program);
    if (theatre) params.set("theatre", theatre);
    if (region) params.set("region", region);
    if (country) params.set("country", country);
    params.set("sort", sortKey);
    params.set("sortDir", sortDir);
    return params;
  }, [program, theatre, region, country, sortKey, sortDir]);

  useEffect(() => {
    const qs = buildViewParams().toString();
    if (qs !== searchParams.toString()) {
      router.replace(`${pathname}?${qs}`, { scroll: false });
    }
  }, [buildViewParams, pathname, router, searchParams]);

  const { capturePageVisuals } = useChartCapture();
  const [exporting, setExporting] = useState(false);

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

  const handleExport = async (fmt: ExportFormat, { includeCharts }: { includeCharts: boolean }) => {
    if (fmt === "csv") return exportToCsv(exportRows as never, exportColumns as never, "program-compliance-trend");
    if (fmt === "excel") return exportToExcel(exportRows as never, exportColumns as never, "program-compliance-trend");
    setExporting(true);
    try {
      exportReportTablePdf({
        title: "Program Compliance Trend",
        filename: "program-compliance-trend",
        columns: exportColumns,
        rows: exportRows as never,
        // Charts and the KPI strip travel together: one tickbox governs both.
        ...(includeCharts ? await capturePageVisuals() : {}),
      });
    } finally {
      setExporting(false);
    }
  };

  if (loading || !data) {
    return <LoadingState label="Loading report…" />;
  }

  return (
    <div>
      <PageHeader
        title="Program Compliance Trend"
        description="Twelve months of point-in-time compliance history, plus a twelve-month expiry-driven forecast."
        backHref="/reports"
        backLabel="Reports"
        helpSlug="reports-program-compliance-trend"
        rightContent={<ExportMenu onExport={handleExport} busy={exporting} />}
      />

      <FilterBar>
        <FilterBar.Row>
          <select value={program} onChange={(e) => setProgram(e.target.value)} className={SELECT_CLASS}>
            <option value="">All Programs</option>
            {data.programs.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={theatre} onChange={(e) => { setTheatre(e.target.value); setRegion(""); setCountry(""); }} className={SELECT_CLASS}>
            <option value="">All Theatres</option>
            {theatreOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={region} onChange={(e) => { setRegion(e.target.value); setCountry(""); }} className={SELECT_CLASS}>
            <option value="">All Regions</option>
            {regionOptions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={country} onChange={(e) => setCountry(e.target.value)} className={SELECT_CLASS}>
            <option value="">All Countries</option>
            {countryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </FilterBar.Row>
      </FilterBar>

      <KpiStrip
        cards={[
          { label: "Current Compliance (avg)", value: `${kpis.current}%`, icon: ShieldCheck, tone: "blue" },
          { label: "Forecast 12-mo Δ (pp)", value: `${kpis.forecastDelta >= 0 ? "+" : ""}${kpis.forecastDelta}`, icon: TrendingUp, tone: kpis.forecastDelta >= 0 ? "emerald" : "red" },
          { label: "Specialisations Tracked", value: kpis.specsTracked, icon: Award, tone: "indigo" },
          { label: "Snapshots", value: kpis.snapshots, icon: BarChart3, tone: "amber" },
        ]}
      />

      <ExportableChart as="section" className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <div className="flex items-start justify-between mb-1 gap-4 flex-wrap">
          <h3 className="text-base font-semibold text-gray-900">Compliance % by Specialisation — 12-Month History &amp; Forecast</h3>
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
      </ExportableChart>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <p className="text-sm text-gray-500">Raw monthly snapshots (attained vs required) per specialisation</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("program")}>Program{sortIndicator("program")}</th>
                <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("specialisation")}>Specialisation{sortIndicator("specialisation")}</th>
                <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("monthKey")}>Month{sortIndicator("monthKey")}</th>
                <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("projected")}>Type{sortIndicator("projected")}</th>
                <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none" onClick={() => toggleSort("attained")}>Attained{sortIndicator("attained")}</th>
                <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none" onClick={() => toggleSort("required")}>Required{sortIndicator("required")}</th>
                <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none" onClick={() => toggleSort("compliancePct")}>Compliance{sortIndicator("compliancePct")}</th>
              </tr>
            </thead>
            <tbody>
              {sortedSnapshots.map((s, i) => (
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

export default function ProgramComplianceTrendPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading report…" />}>
      <ProgramComplianceTrendPageInner />
    </Suspense>
  );
}
