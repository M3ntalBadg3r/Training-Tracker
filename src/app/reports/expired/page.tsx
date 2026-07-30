"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { resolveBucket, GROUP_BY_LABEL, GroupByMode } from "@/lib/group-by";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useDebounce } from "@/hooks/useDebounce";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import GeoScopeFilter, { GeoScope } from "@/components/reports/GeoScopeFilter";
import { Search, Download, ArrowLeft, CalendarX, AlertCircle, AlertTriangle, History } from "lucide-react";
import Pagination from "@/components/data-table/Pagination";
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

interface ExpiredRow {
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
  isLegacy: boolean;
}

type TypeCounts = { name: string; Certification: number; Accreditation: number; "Instructor-Led Training": number; OLX: number };

interface ExpiredResponse {
  charts: { bucketSeries: (TypeCounts & { bucketKey: string })[]; theatreSeries: TypeCounts[] };
  kpis: { total: number; m1: number; m3: number; longOverdue: number };
  groups: { key: string; total: number }[];
  rows: ExpiredRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: { types: string[]; theatres: string[]; regions: string[]; countries: string[] };
}

function typeBadgeClass(t: string): string {
  if (t === "Certification") return "bg-blue-100 text-blue-800";
  if (t === "Accreditation") return "bg-emerald-100 text-emerald-800";
  if (t === "OLX") return "bg-sky-100 text-sky-800";
  return "bg-amber-100 text-amber-800";
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

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
  { key: "retired", header: "Retired" },
];

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

function parseGroupBy(v: string | null, fallback: GroupByMode | null): GroupByMode | null {
  if (v === "none") return null;
  if (v === "theatre" || v === "region" || v === "country") return v;
  return fallback;
}

const WINDOW_OPTIONS = [
  { value: "all", label: "Lapsed Any Time" },
  { value: "3", label: "Lapsed ≤ 3 Months Ago" },
  { value: "6", label: "Lapsed ≤ 6 Months Ago" },
  { value: "12", label: "Lapsed ≤ 12 Months Ago" },
];

/**
 * Does a lapse band still overlap the chosen window? Each chart band key encodes
 * its own lower bound ("6-12" -> 6, "12+" -> 12) and a window of N keeps records
 * with monthsBetween <= N, so a band is in range iff its lower bound is below N.
 * Mirrors `bucketWithinWindow` in `lib/expired-report.ts` (which can't be imported
 * here — that module pulls in Prisma).
 */
function bucketWithinWindow(bucketKey: string, windowValue: string): boolean {
  if (windowValue === "all") return true;
  const months = parseInt(windowValue, 10);
  if (!Number.isFinite(months) || months <= 0) return true;
  return parseInt(bucketKey, 10) < months;
}

function ExpiredPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const chart = useChartTheme();
  const { formatDate } = useDateFormat();
  const companyScope = useCompanyScope();

  // Seed from the URL so Back from a record restores filters + page (mirrored
  // back by the effect below).
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const debouncedSearch = useDebounce(search, 300);
  const [filterType, setFilterType] = useState(() => searchParams.get("type") ?? "");
  const [geo, setGeo] = useState<GeoScope>(() => ({
    theatre: searchParams.get("theatre") ?? "",
    region: searchParams.get("region") ?? "",
    country: searchParams.get("country") ?? "",
  }));
  const [filterBucket, setFilterBucket] = useState<string | null>(() => searchParams.get("bucket"));
  const [filterWindow, setFilterWindow] = useState(() => searchParams.get("window") ?? "all"); // all | 3 | 6 | 12
  const [excludeRetired, setExcludeRetired] = useState(() => searchParams.get("excludeRetired") === "true");
  const [groupBy, setGroupBy] = useState<GroupByMode | null>(() => parseGroupBy(searchParams.get("groupBy"), "theatre"));
  const [sortColumn, setSortColumn] = useState(() => searchParams.get("sort") ?? "fullName");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => (searchParams.get("sortDir") === "desc" ? "desc" : "asc"));
  const [page, setPage] = useState(() => Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1));
  const [pageSize, setPageSize] = useState(() => parseInt(searchParams.get("pageSize") ?? "25", 10) || 25);

  const [data, setData] = useState<ExpiredResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Build the query string shared by the page fetch and the export fetch.
  const buildParams = useCallback(
    (opts: { all?: boolean }) => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (filterType) params.set("type", filterType);
      if (geo.theatre) params.set("theatre", geo.theatre);
      if (geo.region) params.set("region", geo.region);
      if (geo.country) params.set("country", geo.country);
      if (filterBucket) params.set("bucket", filterBucket);
      params.set("window", filterWindow);
      if (excludeRetired) params.set("excludeRetired", "true");
      if (groupBy) params.set("groupBy", groupBy);
      params.set("sort", sortColumn);
      params.set("sortDir", sortDir);
      if (opts.all) params.set("all", "true");
      else {
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));
      }
      return params;
    },
    [debouncedSearch, filterType, geo, filterBucket, filterWindow, excludeRetired, groupBy, sortColumn, sortDir, page, pageSize]
  );

  // Reset to page 1 when a filter/sort/scope changes — but not on initial mount,
  // so a URL-seeded page survives back-navigation.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setPage(1);
  }, [debouncedSearch, filterType, geo, filterBucket, filterWindow, excludeRetired, groupBy, sortColumn, sortDir, companyScope.selected]);

  // Mirror view state to the URL so Back restores filters + page. groupBy is
  // written explicitly (with a "none" sentinel) because its default is "theatre".
  useEffect(() => {
    const params = buildParams({});
    if (search) params.set("q", search);
    else params.delete("q");
    params.set("groupBy", groupBy ?? "none");
    const qs = params.toString();
    const next = qs ? `${pathname}?${qs}` : pathname;
    if (qs !== searchParams.toString()) {
      router.replace(next, { scroll: false });
    }
  }, [buildParams, search, groupBy, pathname, router, searchParams]);

  useEffect(() => {
    if (companyScope.loading) return;
    const url = withCompany(`/api/reports/expired?${buildParams({}).toString()}`, companyScope.selected);
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then((r) => r.json())
      .then((d: ExpiredResponse) => {
        if (!cancelled) setData(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [buildParams, companyScope.loading, companyScope.selected]);

  const charts = data?.charts ?? { bucketSeries: [], theatreSeries: [] };
  const kpis = data?.kpis ?? { total: 0, m1: 0, m3: 0, longOverdue: 0 };
  const rows = data?.rows ?? [];
  const groups = data?.groups ?? [];
  const total = data?.total ?? 0;
  const types = data?.filterOptions.types ?? [];

  const toggleSort = (key: string) => {
    if (key === sortColumn) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(key);
      setSortDir("asc");
    }
  };
  const sortIndicator = (key: string) => (sortColumn === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  const handleExport = async (fmt: "csv" | "excel" | "pdf") => {
    setExporting(true);
    try {
      const url = withCompany(`/api/reports/expired?${buildParams({ all: true }).toString()}`, companyScope.selected);
      const res = await fetch(url);
      const d: ExpiredResponse = await res.json();
      const exportRows = d.rows.map((r) => ({
        ...r,
        completedDate: formatDate(r.completedDate),
        expiryDate: formatDate(r.expiryDate),
        retired: r.isLegacy ? "Yes" : "No",
      }));
      if (fmt === "csv") exportToCsv(exportRows as never, exportColumns as never, "currently-expired");
      else if (fmt === "excel") exportToExcel(exportRows as never, exportColumns as never, "currently-expired");
      else exportToPdf(exportRows as never, exportColumns as never, "currently-expired");
    } finally {
      setExporting(false);
    }
  };

  if (loading && !data) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>;
  }

  const renderRow = (row: ExpiredRow, idx: number) => (
    <tr key={`${row.email}-${row.trainingTitle}-${idx}`} className="border-b hover:bg-gray-50">
      <td className="px-4 py-3">{row.fullName}</td>
      <td className="px-4 py-3">{row.email}</td>
      <td className="px-4 py-3">{row.theatre || "-"}</td>
      <td className="px-4 py-3">{row.region || "-"}</td>
      <td className="px-4 py-3">{row.country || "-"}</td>
      <td className="px-4 py-3">
        {row.trainingTitle}
        {row.isLegacy && (
          <span className="ml-2 inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-600">Retired</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${typeBadgeClass(row.trainingType)}`}>
          {row.trainingType}
        </span>
      </td>
      <td className="px-4 py-3">{row.productType}</td>
      <td className="px-4 py-3">{row.function}</td>
      <td className="px-4 py-3">{formatDate(row.completedDate)}</td>
      <td className="px-4 py-3 text-red-700 font-medium">{formatDate(row.expiryDate)}</td>
      <td className="px-4 py-3">
        <button onClick={() => router.push(`/students/${encodeURIComponent(row.email)}`)} className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors">View</button>
      </td>
    </tr>
  );

  // Build the table body: flat rows, or (when grouping) group headers + server
  // subtotals inserted at group boundaries within the current page.
  const renderBody = () => {
    if (rows.length === 0) {
      return (
        <tbody>
          <tr>
            <td colSpan={12} className="px-4 py-8 text-center text-gray-500">No expired records match the current filters.</td>
          </tr>
        </tbody>
      );
    }
    if (!groupBy) {
      return <tbody>{rows.map((row, idx) => renderRow(row, idx))}</tbody>;
    }
    const totals = new Map(groups.map((g) => [g.key, g.total]));
    const groupLabel = GROUP_BY_LABEL[groupBy];
    const items: React.ReactNode[] = [];
    let prevKey: string | null = null;
    const subtotal = (key: string) => {
      const n = totals.get(key) ?? 0;
      items.push(
        <tr key={`s-${key}`} className="bg-gray-50 border-b font-medium text-xs text-gray-600">
          <td colSpan={12} className="px-4 py-2">Subtotal — {n} expired record{n !== 1 ? "s" : ""}</td>
        </tr>
      );
    };
    rows.forEach((row, idx) => {
      const key = resolveBucket(row, groupBy);
      if (key !== prevKey) {
        if (prevKey !== null) subtotal(prevKey);
        const n = totals.get(key) ?? 0;
        items.push(
          <tr key={`h-${key}`} className="bg-gray-100 border-b">
            <td colSpan={12} className="px-4 py-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                <span>{groupLabel}: {key}</span>
                <span className="ml-auto text-xs font-normal text-gray-500">{n} record{n !== 1 ? "s" : ""}</span>
              </div>
            </td>
          </tr>
        );
        prevKey = key;
      }
      items.push(renderRow(row, idx));
    });
    if (prevKey !== null) subtotal(prevKey);
    return <tbody>{items}</tbody>;
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Reports
        </Link>
      </div>
      <PageHeader title="Currently Expired" helpSlug="reports" />

      <KpiStrip
        cards={[
          { label: "Total Expired", value: kpis.total, icon: CalendarX, tone: "red" },
          { label: "Lapsed ≤ 1 month", value: kpis.m1, icon: AlertCircle, tone: "amber" },
          { label: "Lapsed ≤ 3 months", value: kpis.m3, icon: AlertTriangle, tone: "indigo" },
          { label: "Overdue > 12 months", value: kpis.longOverdue, icon: History, tone: "red" },
        ]}
      />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">How Long Ago They Lapsed</h3>
            {filterBucket && (
              <button onClick={() => setFilterBucket(null)} className="text-xs text-blue-600 hover:underline">Clear band filter</button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={charts.bucketSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Bar dataKey="Certification" stackId="a" fill={chart.typeColor("Certification")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { bucketKey?: string }).bucketKey; if (k) setFilterBucket(k); }) as never} />
              <Bar dataKey="Accreditation" stackId="a" fill={chart.typeColor("Accreditation")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { bucketKey?: string }).bucketKey; if (k) setFilterBucket(k); }) as never} />
              <Bar dataKey="Instructor-Led Training" stackId="a" fill={chart.typeColor("Instructor-Led Training")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { bucketKey?: string }).bucketKey; if (k) setFilterBucket(k); }) as never} />
              <Bar dataKey="OLX" stackId="a" fill={chart.typeColor("OLX")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { bucketKey?: string }).bucketKey; if (k) setFilterBucket(k); }) as never} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-400 mt-2">Click a band to filter the table to that lapse age</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Expired by Theatre</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={charts.theatreSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Bar dataKey="Certification" stackId="a" fill={chart.typeColor("Certification")} />
              <Bar dataKey="Accreditation" stackId="a" fill={chart.typeColor("Accreditation")} />
              <Bar dataKey="Instructor-Led Training" stackId="a" fill={chart.typeColor("Instructor-Led Training")} />
              <Bar dataKey="OLX" stackId="a" fill={chart.typeColor("OLX")} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">
            Certifications &amp; trainings whose latest completion has already expired
            {filterWindow !== "all" && ` — lapsed within the last ${filterWindow} months`}
          </p>
          <span className="text-sm font-medium text-gray-500">{total} result{total !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
              </div>
              <ExportMenu onExport={handleExport} busy={exporting} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={filterWindow}
                onChange={(e) => {
                  const w = e.target.value;
                  setFilterWindow(w);
                  // A band outside the new window could only ever render an empty report.
                  if (filterBucket && !bucketWithinWindow(filterBucket, w)) setFilterBucket(null);
                }}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                {WINDOW_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Types</option>
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <GeoScopeFilter value={geo} onChange={setGeo} selectClassName="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" />
              <select value={groupBy ?? ""} onChange={(e) => setGroupBy((e.target.value as GroupByMode) || null)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">No Grouping</option>
                <option value="theatre">Group by Theatre</option>
                <option value="region">Group by Region</option>
                <option value="country">Group by Country</option>
              </select>
              <label className="flex items-center gap-2 text-sm text-gray-600 select-none">
                <input type="checkbox" checked={excludeRetired} onChange={(e) => setExcludeRetired(e.target.checked)} className="rounded border-gray-300" />
                Exclude retired (legacy) certs
              </label>
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
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("expiryDate")}>Expired{sortIndicator("expiryDate")}</th>
                  <th className="px-4 py-3 text-left font-semibold"></th>
                </tr>
              </thead>
              {renderBody()}
            </table>
          </div>

          <div className="mt-4">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageChange={setPage}
              onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ExpiredPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>}>
      <ExpiredPageInner />
    </Suspense>
  );
}
