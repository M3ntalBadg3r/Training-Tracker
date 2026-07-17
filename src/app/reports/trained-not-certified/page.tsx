"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { useProductTypeColors } from "@/hooks/useProductTypeColors";
import { resolveBucket, GROUP_BY_LABEL, GroupByMode } from "@/lib/group-by";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useDebounce } from "@/hooks/useDebounce";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import { Search, Download, ArrowLeft, AlertCircle, Award, GraduationCap, Users } from "lucide-react";
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

interface TncResponse {
  charts: {
    productSeries: { name: string; "ILT Completed": number; "ILT Still Active": number }[];
    bucketSeries: { name: string; count: number }[];
  };
  kpis: { total: number; activeIlt: number; distinctStudents: number; distinctIlts: number };
  groups: { key: string; total: number; active: number }[];
  rows: TrainedNotCertifiedRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: {
    theatres: string[];
    regions: string[];
    countries: string[];
    productTypes: string[];
    iltTitles: string[];
    certTitles: string[];
  };
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

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

function TrainedNotCertifiedPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const chart = useChartTheme();
  const productColors = useProductTypeColors();
  const { formatDate } = useDateFormat();
  const companyScope = useCompanyScope();

  // Seed from the URL so Back from a record restores filters + page (mirrored
  // back by the effect below).
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const debouncedSearch = useDebounce(search, 300);
  const [filterTheatre, setFilterTheatre] = useState(() => searchParams.get("theatre") ?? "");
  const [filterRegion, setFilterRegion] = useState(() => searchParams.get("region") ?? "");
  const [filterCountry, setFilterCountry] = useState(() => searchParams.get("country") ?? "");
  const [filterProduct, setFilterProduct] = useState(() => searchParams.get("product") ?? "");
  const [filterIlt, setFilterIlt] = useState(() => searchParams.get("ilt") ?? "");
  const [filterCert, setFilterCert] = useState(() => searchParams.get("cert") ?? "");
  const [filterActive, setFilterActive] = useState(() => searchParams.get("active") ?? "");
  const [groupBy, setGroupBy] = useState<GroupByMode | null>(() => parseGroupBy(searchParams.get("groupBy"), "theatre"));
  const [sortColumn, setSortColumn] = useState(() => searchParams.get("sort") ?? "fullName");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => (searchParams.get("sortDir") === "desc" ? "desc" : "asc"));
  const [page, setPage] = useState(() => Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1));
  const [pageSize, setPageSize] = useState(() => parseInt(searchParams.get("pageSize") ?? "25", 10) || 25);

  const [data, setData] = useState<TncResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const buildParams = useCallback(
    (opts: { all?: boolean }) => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (filterTheatre) params.set("theatre", filterTheatre);
      if (filterRegion) params.set("region", filterRegion);
      if (filterCountry) params.set("country", filterCountry);
      if (filterProduct) params.set("product", filterProduct);
      if (filterIlt) params.set("ilt", filterIlt);
      if (filterCert) params.set("cert", filterCert);
      if (filterActive) params.set("active", filterActive);
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
    [debouncedSearch, filterTheatre, filterRegion, filterCountry, filterProduct, filterIlt, filterCert, filterActive, groupBy, sortColumn, sortDir, page, pageSize]
  );

  // Reset to page 1 on filter/sort/scope change — but not on initial mount, so a
  // URL-seeded page survives back-navigation.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setPage(1);
  }, [debouncedSearch, filterTheatre, filterRegion, filterCountry, filterProduct, filterIlt, filterCert, filterActive, groupBy, sortColumn, sortDir, companyScope.selected]);

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
    const url = withCompany(`/api/reports/trained-not-certified?${buildParams({}).toString()}`, companyScope.selected);
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then((r) => r.json())
      .then((d: TncResponse) => {
        if (!cancelled) setData(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [buildParams, companyScope.loading, companyScope.selected]);

  const charts = data?.charts ?? { productSeries: [], bucketSeries: [] };
  const kpis = data?.kpis ?? { total: 0, activeIlt: 0, distinctStudents: 0, distinctIlts: 0 };
  const rows = data?.rows ?? [];
  const groups = data?.groups ?? [];
  const total = data?.total ?? 0;
  const opts = data?.filterOptions ?? { theatres: [], regions: [], countries: [], productTypes: [], iltTitles: [], certTitles: [] };

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
      const url = withCompany(`/api/reports/trained-not-certified?${buildParams({ all: true }).toString()}`, companyScope.selected);
      const res = await fetch(url);
      const d: TncResponse = await res.json();
      const exportRows = d.rows.map((r) => ({
        ...r,
        iltCompletedDate: formatDate(r.iltCompletedDate),
        iltActive: r.iltActive ? "Yes" : "No",
      }));
      if (fmt === "csv") exportToCsv(exportRows as never, exportColumns as never, "trained-not-certified");
      else if (fmt === "excel") exportToExcel(exportRows as never, exportColumns as never, "trained-not-certified");
      else exportToPdf(exportRows as never, exportColumns as never, "trained-not-certified");
    } finally {
      setExporting(false);
    }
  };

  if (loading && !data) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>;
  }

  const renderRow = (row: TrainedNotCertifiedRow, idx: number) => (
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
  );

  const renderBody = () => {
    if (rows.length === 0) {
      return (
        <tbody>
          <tr>
            <td colSpan={11} className="px-4 py-8 text-center text-gray-500">No results match the current filters. Ensure ILT trainings have certification mappings in Training Data.</td>
          </tr>
        </tbody>
      );
    }
    if (!groupBy) {
      return <tbody>{rows.map((row, idx) => renderRow(row, idx))}</tbody>;
    }
    const totals = new Map(groups.map((g) => [g.key, g]));
    const groupLabel = GROUP_BY_LABEL[groupBy];
    const items: React.ReactNode[] = [];
    let prevKey: string | null = null;
    const subtotal = (key: string) => {
      const g = totals.get(key);
      const n = g?.total ?? 0;
      const act = g?.active ?? 0;
      items.push(
        <tr key={`s-${key}`} className="bg-gray-50 border-b font-medium text-xs text-gray-600">
          <td colSpan={11} className="px-4 py-2">Subtotal — {n} gap{n !== 1 ? "s" : ""} · {act} ILT still active</td>
        </tr>
      );
    };
    rows.forEach((row, idx) => {
      const key = resolveBucket(row, groupBy);
      if (key !== prevKey) {
        if (prevKey !== null) subtotal(prevKey);
        const n = totals.get(key)?.total ?? 0;
        items.push(
          <tr key={`h-${key}`} className="bg-gray-100 border-b">
            <td colSpan={11} className="px-4 py-2">
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
            <BarChart data={charts.productSeries}>
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
            <BarChart data={charts.bucketSeries} layout="vertical" margin={{ left: 60 }}>
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
            <div className="flex flex-wrap gap-3">
              <select value={filterTheatre} onChange={(e) => setFilterTheatre(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Theatres</option>
                {opts.theatres.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={filterRegion} onChange={(e) => setFilterRegion(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Regions</option>
                {opts.regions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <select value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Countries</option>
                {opts.countries.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Products</option>
                {opts.productTypes.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select value={filterIlt} onChange={(e) => setFilterIlt(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Trainings</option>
                {opts.iltTitles.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={filterCert} onChange={(e) => setFilterCert(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Certifications</option>
                {opts.certTitles.map((c) => <option key={c} value={c}>{c}</option>)}
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

export default function TrainedNotCertifiedPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>}>
      <TrainedNotCertifiedPageInner />
    </Suspense>
  );
}
