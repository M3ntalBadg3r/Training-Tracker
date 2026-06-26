"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { useTableSort, SortAccessor } from "@/hooks/useTableSort";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { ArrowLeft, Download, RefreshCw, AlertTriangle, TrendingUp, RotateCcw } from "lucide-react";
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

interface MonthRow {
  monthKey: string;
  monthLabel: string;
  expiringCount: number;
  projectedRenewed: number;
  projectedLapsed: number;
}

interface TitleRow {
  fullTitle: string;
  productType: string;
  expiringCount: number;
  rate: number;
  rateSource: string;
  projectedLapsed: number;
}

interface ForecastResponse {
  monthly: MonthRow[];
  titleRows: TitleRow[];
  globalRate: number;
  historicalRenewed: number;
  historicalLapsed: number;
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

export default function RenewalForecastPage() {
  const chart = useChartTheme();
  const companyScope = useCompanyScope();
  const [data, setData] = useState<ForecastResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterProduct, setFilterProduct] = useState("");
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
    if (country) params.set("country", country);
    else if (region) params.set("region", region);
    else if (theatre) params.set("theatre", theatre);
    const qs = params.toString();
    const base = `/api/reports/renewal-forecast${qs ? `?${qs}` : ""}`;
    fetch(withCompany(base, companyScope.selected))
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [companyScope.loading, companyScope.selected, theatre, region, country]);

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

  const scoped = !!(country || region || theatre);

  const products = useMemo(() => [...new Set(data?.titleRows.map((r) => r.productType) ?? [])].sort(), [data]);

  const filteredTitleRows = useMemo(() => {
    if (!data) return [];
    return filterProduct ? data.titleRows.filter((r) => r.productType === filterProduct) : data.titleRows;
  }, [data, filterProduct]);

  const totals = useMemo(() => {
    if (!data) return { next6Renewed: 0, next6Lapsed: 0, next12Renewed: 0, next12Lapsed: 0 };
    const slice6 = data.monthly.slice(0, 6);
    const slice12 = data.monthly;
    const sum = (arr: MonthRow[], k: keyof MonthRow) => arr.reduce((s, m) => s + (m[k] as number), 0);
    return {
      next6Renewed: sum(slice6, "projectedRenewed"),
      next6Lapsed: sum(slice6, "projectedLapsed"),
      next12Renewed: sum(slice12, "projectedRenewed"),
      next12Lapsed: sum(slice12, "projectedLapsed"),
    };
  }, [data]);

  // Column sorting for the at-risk table (defaults to highest projected lapses,
  // preserving the report's "ranked by projected lapses" intent).
  const sortAccessors: Record<string, SortAccessor<TitleRow>> = {
    fullTitle: (r) => r.fullTitle,
    productType: (r) => r.productType,
    expiringCount: (r) => r.expiringCount,
    rate: (r) => r.rate,
    rateSource: (r) => r.rateSource,
    projectedLapsed: (r) => r.projectedLapsed,
  };
  const { sorted: sortedTitleRows, toggleSort, sortIndicator } = useTableSort(filteredTitleRows, sortAccessors, {
    defaultKey: "projectedLapsed",
    defaultDir: "desc",
    tiebreakKey: "fullTitle",
    descFirstKeys: ["expiringCount", "rate", "projectedLapsed"],
  });

  const exportColumns = [
    { key: "fullTitle", header: "Training" },
    { key: "productType", header: "Product" },
    { key: "expiringCount", header: "Expiring (12m)" },
    { key: "rate", header: "Renewal Rate %" },
    { key: "rateSource", header: "Rate Basis" },
    { key: "projectedLapsed", header: "Projected Lapses" },
  ];
  const exportRows = filteredTitleRows.map((r) => ({ ...r, rate: r.rate.toFixed(1) }));

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
      <PageHeader title="Renewal Forecast" helpSlug="reports-renewal-forecast" />

      <section className="bg-white rounded-lg border border-gray-200 p-4 mb-6 flex flex-wrap items-center gap-3">
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
        <span className="text-xs text-gray-500">
          Showing: <span className="font-medium text-gray-700">{data.scopeLabel}</span> · scoped to the company selected above.
        </span>
      </section>

      <KpiStrip
        cards={[
          { label: scoped ? "Renewal Rate" : "Global Renewal Rate", value: `${data.globalRate}%`, icon: RefreshCw, tone: "blue", hint: `${data.historicalRenewed} renewed / ${data.historicalLapsed} lapsed` },
          { label: "Forecast Renewals (6m)", value: totals.next6Renewed, icon: RotateCcw, tone: "emerald" },
          { label: "Forecast Lapses (6m)", value: totals.next6Lapsed, icon: AlertTriangle, tone: "red" },
          { label: "Forecast Renewals (12m)", value: totals.next12Renewed, icon: TrendingUp, tone: "indigo" },
        ]}
      />

      <section className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 className="text-base font-semibold text-gray-900 mb-4">Forecast: Projected Renewals vs Lapses by Month</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data.monthly}>
            <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
            <XAxis dataKey="monthLabel" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={50} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
            <Tooltip contentStyle={tooltipStyle(chart)} />
            <Legend />
            <Bar dataKey="projectedRenewed" stackId="a" fill={chart.typeColor("Accreditation")} name="Projected Renewed" />
            <Bar dataKey="projectedLapsed" stackId="a" fill={chart.isDark ? "#f87171" : "#ef4444"} name="Projected Lapsed" />
          </BarChart>
        </ResponsiveContainer>
        <p className="text-xs text-gray-400 mt-2">
          Renewal rates are computed per training (≥5 historical expiries), then per product as fallback, then global ({data.globalRate}%).
          A renewal counts when a learner later re-completes the same training; an expired record with no later re-completion counts as a lapse.
        </p>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">At-risk titles, ranked by projected lapses over the next 12 months</p>
          <span className="text-sm font-medium text-gray-500">{filteredTitleRows.length} title{filteredTitleRows.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-wrap gap-3 mb-4">
            <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">All Products</option>
              {products.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <ExportMenu data={exportRows as never} columns={exportColumns} filename="renewal-forecast" />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("fullTitle")}>Training{sortIndicator("fullTitle")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("productType")}>Product{sortIndicator("productType")}</th>
                  <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none" onClick={() => toggleSort("expiringCount")}>Expiring (12m){sortIndicator("expiringCount")}</th>
                  <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none" onClick={() => toggleSort("rate")}>Renewal Rate{sortIndicator("rate")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("rateSource")}>Rate Basis{sortIndicator("rateSource")}</th>
                  <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none" onClick={() => toggleSort("projectedLapsed")}>Projected Lapses{sortIndicator("projectedLapsed")}</th>
                </tr>
              </thead>
              <tbody>
                {sortedTitleRows.map((r, i) => (
                  <tr key={`${r.fullTitle}-${i}`} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3">{r.fullTitle}</td>
                    <td className="px-4 py-3">{r.productType}</td>
                    <td className="px-4 py-3 text-right">{r.expiringCount}</td>
                    <td className="px-4 py-3 text-right">{r.rate.toFixed(1)}%</td>
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700 capitalize">{r.rateSource}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`inline-block px-2 py-0.5 rounded font-medium ${r.projectedLapsed >= 10 ? "bg-red-100 text-red-800" : r.projectedLapsed >= 3 ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>
                        {r.projectedLapsed}
                      </span>
                    </td>
                  </tr>
                ))}
                {filteredTitleRows.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No upcoming expiries to forecast.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
