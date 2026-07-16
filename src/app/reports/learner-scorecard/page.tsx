"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useDebounce } from "@/hooks/useDebounce";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import { ArrowLeft, Download, Users, Award, AlertTriangle, Clock, ChevronLeft, ChevronRight } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface LearnerRow {
  email: string;
  fullName: string;
  theatre: string;
  region: string;
  country: string;
  cert: number;
  accred: number;
  ilt: number;
  olx: number;
  total: number;
  expiring: number;
  lapsed: number;
  gaps: number;
  lastDate: string;
}

type SortKey =
  | "fullName" | "cert" | "accred" | "ilt" | "olx"
  | "total" | "expiring" | "lapsed" | "gaps" | "lastDate";

interface ScorecardResponse {
  kpis: { learners: number; achievements: number; withGaps: number; withExpiring: number; zero: number };
  leaderboard: { name: string; total: number }[];
  rows: LearnerRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: { theatres: string[]; regions: string[]; countries: string[] };
}

const WINDOW_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Expiring in 1 month" },
  { value: 3, label: "Expiring in 3 months" },
  { value: 6, label: "Expiring in 6 months" },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

function ExportMenu({ onExport, busy }: { onExport: (fmt: "csv" | "excel" | "pdf") => void; busy: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setShow((p) => !p)} disabled={busy} className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300 disabled:opacity-50">
        <Download size={16} /> {busy ? "Exporting…" : "Export"}
      </button>
      {show && !busy && (
        <div className="absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
          <button onClick={() => { onExport("csv"); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg">Export as CSV</button>
          <button onClick={() => { onExport("excel"); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100">Export as Excel</button>
          <button onClick={() => { onExport("pdf"); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg">Export as PDF</button>
        </div>
      )}
    </div>
  );
}

export default function LearnerScorecardPage() {
  const chart = useChartTheme();
  const companyScope = useCompanyScope();
  const { formatDate } = useDateFormat();

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [filterTheatre, setFilterTheatre] = useState("");
  const [filterRegion, setFilterRegion] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [windowMonths, setWindowMonths] = useState(6);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [data, setData] = useState<ScorecardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const buildParams = useCallback(
    (opts: { all?: boolean }) => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (filterTheatre) params.set("theatre", filterTheatre);
      if (filterRegion) params.set("region", filterRegion);
      if (filterCountry) params.set("country", filterCountry);
      params.set("windowMonths", String(windowMonths));
      if (includeExpired) params.set("includeExpired", "true");
      params.set("sort", sortKey);
      params.set("sortDir", sortDir);
      if (opts.all) params.set("all", "true");
      else {
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));
      }
      return params;
    },
    [debouncedSearch, filterTheatre, filterRegion, filterCountry, windowMonths, includeExpired, sortKey, sortDir, page, pageSize]
  );

  // Reset to page 1 whenever a filter/toggle/sort/scope changes.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, filterTheatre, filterRegion, filterCountry, windowMonths, includeExpired, sortKey, sortDir, companyScope.selected]);

  useEffect(() => {
    if (companyScope.loading) return;
    const url = withCompany(`/api/reports/learner-scorecard?${buildParams({}).toString()}`, companyScope.selected);
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then((r) => r.json())
      .then((d: ScorecardResponse) => {
        if (!cancelled) setData(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [buildParams, companyScope.loading, companyScope.selected]);

  const kpis = data?.kpis ?? { learners: 0, achievements: 0, withGaps: 0, withExpiring: 0, zero: 0 };
  const leaderboard = data?.leaderboard ?? [];
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const theatres = data?.filterOptions.theatres ?? [];
  const regions = data?.filterOptions.regions ?? [];
  const countries = data?.filterOptions.countries ?? [];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "fullName" ? "asc" : "desc");
    }
  }
  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");
  const numHeader = (key: SortKey, label: string) => (
    <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none whitespace-nowrap" onClick={() => toggleSort(key)}>
      {label}{sortIndicator(key)}
    </th>
  );

  const exportColumns = [
    { key: "fullName", header: "Name" },
    { key: "email", header: "Email" },
    { key: "theatre", header: "Theatre" },
    { key: "region", header: "Region" },
    { key: "country", header: "Country" },
    { key: "cert", header: "Certifications" },
    { key: "accred", header: "Accreditations" },
    { key: "ilt", header: "ILTs" },
    { key: "olx", header: "OLX" },
    { key: "total", header: "Total" },
    { key: "expiring", header: `Expiring Soon (${windowMonths}mo)` },
    { key: "lapsed", header: "Expired" },
    { key: "gaps", header: "Cert Gaps" },
    { key: "lastDate", header: "Last Achievement" },
  ];

  const handleExport = async (fmt: "csv" | "excel" | "pdf") => {
    setExporting(true);
    try {
      const url = withCompany(`/api/reports/learner-scorecard?${buildParams({ all: true }).toString()}`, companyScope.selected);
      const res = await fetch(url);
      const d: ScorecardResponse = await res.json();
      const exportRows = d.rows.map((l) => ({ ...l, lastDate: l.lastDate ? formatDate(l.lastDate) : "" }));
      if (fmt === "csv") exportToCsv(exportRows as never, exportColumns as never, "learner-scorecard");
      else if (fmt === "excel") exportToExcel(exportRows as never, exportColumns as never, "learner-scorecard");
      else exportToPdf(exportRows as never, exportColumns as never, "learner-scorecard");
    } finally {
      setExporting(false);
    }
  };

  if (loading && !data) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>;
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Reports
        </Link>
      </div>
      <PageHeader title="Learner Achievement Scorecard" helpSlug="reports-learner-scorecard" />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or email…"
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white min-w-[200px]"
        />
        <select value={filterTheatre} onChange={(e) => setFilterTheatre(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
          <option value="">All Theatres</option>
          {theatres.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={filterRegion} onChange={(e) => setFilterRegion(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
          <option value="">All Regions</option>
          {regions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
          <option value="">All Countries</option>
          {countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={windowMonths} onChange={(e) => setWindowMonths(Number(e.target.value))} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
          {WINDOW_OPTIONS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={includeExpired} onChange={(e) => setIncludeExpired(e.target.checked)} className="rounded border-gray-300" />
          Include expired in counts
        </label>
      </div>

      <KpiStrip
        cards={[
          { label: "Learners", value: kpis.learners, icon: Users, tone: "blue", hint: `${kpis.zero.toLocaleString()} with no achievements` },
          { label: includeExpired ? "Total Achievements" : "Active Achievements", value: kpis.achievements, icon: Award, tone: "emerald" },
          { label: "Learners with Cert Gaps", value: kpis.withGaps, icon: AlertTriangle, tone: "amber" },
          { label: `Expiring Soon (${windowMonths}mo)`, value: kpis.withExpiring, icon: Clock, tone: "red" },
        ]}
      />

      <section className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 className="text-base font-semibold text-gray-900 mb-4">
          Top Achievers — {includeExpired ? "total" : "active"} achievements
        </h3>
        {leaderboard.length > 0 ? (
          <ResponsiveContainer width="100%" height={340}>
            <BarChart data={leaderboard} margin={{ bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={70} interval={0} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Bar dataKey="total" name="Achievements" fill={chart.series(0)} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-gray-500 py-8 text-center">No achievements for the selected filters.</p>
        )}
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">
            One row per learner. Counts are {includeExpired ? "all completions" : "active only"}; expiring-soon and gap counts always look forward from today.
          </p>
          <ExportMenu onExport={handleExport} busy={exporting} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("fullName")}>Name{sortIndicator("fullName")}</th>
                <th className="px-4 py-3 text-left font-semibold">Theatre</th>
                <th className="px-4 py-3 text-left font-semibold">Country</th>
                {numHeader("cert", "Certs")}
                {numHeader("accred", "Accreds")}
                {numHeader("ilt", "ILTs")}
                {numHeader("olx", "OLX")}
                {numHeader("total", "Total")}
                {numHeader("expiring", "Expiring Soon")}
                {numHeader("lapsed", "Expired")}
                {numHeader("gaps", "Gaps")}
                {numHeader("lastDate", "Last Achievement")}
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.email} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link href={`/students/${encodeURIComponent(l.email)}`} className="font-medium text-blue-600 hover:underline">{l.fullName}</Link>
                    <div className="text-xs text-gray-400">{l.email}</div>
                  </td>
                  <td className="px-4 py-3">{l.theatre || "—"}</td>
                  <td className="px-4 py-3">{l.country || "—"}</td>
                  <td className="px-4 py-3 text-right">{l.cert.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{l.accred.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{l.ilt.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{l.olx.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-semibold">{l.total.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{l.expiring > 0 ? <span className="text-amber-600 font-medium">{l.expiring}</span> : "—"}</td>
                  <td className="px-4 py-3 text-right">{l.lapsed > 0 ? <span className="text-gray-500">{l.lapsed}</span> : "—"}</td>
                  <td className="px-4 py-3 text-right">{l.gaps > 0 ? <span className="text-red-600 font-medium">{l.gaps}</span> : "—"}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{l.lastDate ? formatDate(l.lastDate) : "—"}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={12} className="px-4 py-8 text-center text-gray-500">No learners for the selected filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-4 flex items-center justify-between flex-wrap gap-3 border-t border-gray-200">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <span>{total === 0 ? "No learners" : `Showing ${rangeStart}–${rangeEnd} of ${total}`}</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} / page</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
            >
              <ChevronLeft size={14} /> Prev
            </button>
            <span className="text-sm text-gray-600">Page {page} of {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
            >
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
