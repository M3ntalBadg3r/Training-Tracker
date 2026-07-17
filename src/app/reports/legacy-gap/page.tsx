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
import GeoScopeFilter, { GeoScope } from "@/components/reports/GeoScopeFilter";
import { Search, Download, ArrowLeft, History, AlertCircle, AlertTriangle, Ban } from "lucide-react";
import Pagination from "@/components/data-table/Pagination";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface LegacyGapRow {
  fullName: string;
  email: string;
  theatre: string;
  region: string;
  country: string;
  legacyTrainingTitle: string;
  legacyFullTitle: string;
  legacyType: string; // "Certification" | "Accreditation"
  productType: string;
  replacementFullTitle: string;
  replacementDefined: boolean;
  replacementState: "never" | "expired-only";
  legacyCompletedDate: string;
  legacyExpiryDate: string;
  legacyActive: boolean;
}

interface LegacyGapResponse {
  charts: {
    horizonSeries: { name: string; Certification: number; Accreditation: number; horizonKey: string }[];
    productSeries: { name: string; gaps: number }[];
  };
  kpis: { total: number; expired: number; soon: number; noReplacement: number };
  groups: { key: string; total: number }[];
  rows: LegacyGapRow[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: { products: string[] };
}

const TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
};

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

function typeBadgeClass(t: string): string {
  if (t === "Certification") return "bg-blue-100 text-blue-800";
  return "bg-emerald-100 text-emerald-800";
}

const exportColumns = [
  { key: "fullName", header: "Full Name" },
  { key: "email", header: "Email" },
  { key: "theatre", header: "Theatre" },
  { key: "region", header: "Region" },
  { key: "country", header: "Country" },
  { key: "legacyFullTitle", header: "Legacy Training" },
  { key: "legacyType", header: "Type" },
  { key: "productType", header: "Product" },
  { key: "replacementFullTitle", header: "Replacement" },
  { key: "legacyCompletedDate", header: "Completed" },
  { key: "legacyExpiryDate", header: "Expires" },
  { key: "legacyActive", header: "Active" },
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

function LegacyGapPageInner() {
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
  const [filterWindow, setFilterWindow] = useState(() => searchParams.get("window") ?? "all"); // all | expired | 1 | 3 | 6 | 12
  const [filterType, setFilterType] = useState(() => searchParams.get("type") ?? "");
  const [filterProduct, setFilterProduct] = useState(() => searchParams.get("product") ?? "");
  const [geo, setGeo] = useState<GeoScope>(() => ({
    theatre: searchParams.get("theatre") ?? "",
    region: searchParams.get("region") ?? "",
    country: searchParams.get("country") ?? "",
  }));
  const [filterHorizon, setFilterHorizon] = useState<string | null>(() => searchParams.get("horizon"));
  const [groupBy, setGroupBy] = useState<GroupByMode | null>(() => parseGroupBy(searchParams.get("groupBy"), "theatre"));
  const [includeNoReplacement, setIncludeNoReplacement] = useState(() => searchParams.get("includeNoReplacement") !== "false");
  const [requireActive, setRequireActive] = useState(() => searchParams.get("requireActive") !== "false");
  const [sortColumn, setSortColumn] = useState(() => searchParams.get("sort") ?? "fullName");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => (searchParams.get("sortDir") === "desc" ? "desc" : "asc"));
  const [page, setPage] = useState(() => Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1));
  const [pageSize, setPageSize] = useState(() => parseInt(searchParams.get("pageSize") ?? "25", 10) || 25);

  const [data, setData] = useState<LegacyGapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const buildParams = useCallback(
    (opts: { all?: boolean }) => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      params.set("window", filterWindow);
      if (filterType) params.set("type", filterType);
      if (filterProduct) params.set("product", filterProduct);
      if (geo.theatre) params.set("theatre", geo.theatre);
      if (geo.region) params.set("region", geo.region);
      if (geo.country) params.set("country", geo.country);
      if (filterHorizon) params.set("horizon", filterHorizon);
      params.set("includeNoReplacement", String(includeNoReplacement));
      params.set("requireActive", String(requireActive));
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
    [debouncedSearch, filterWindow, filterType, filterProduct, geo, filterHorizon, includeNoReplacement, requireActive, groupBy, sortColumn, sortDir, page, pageSize]
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
  }, [debouncedSearch, filterWindow, filterType, filterProduct, geo, filterHorizon, includeNoReplacement, requireActive, groupBy, sortColumn, sortDir, companyScope.selected]);

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
    const url = withCompany(`/api/reports/legacy-gap?${buildParams({}).toString()}`, companyScope.selected);
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then((r) => r.json())
      .then((d: LegacyGapResponse) => {
        if (!cancelled) setData(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [buildParams, companyScope.loading, companyScope.selected]);

  const charts = data?.charts ?? { horizonSeries: [], productSeries: [] };
  const kpis = data?.kpis ?? { total: 0, expired: 0, soon: 0, noReplacement: 0 };
  const rows = data?.rows ?? [];
  const groups = data?.groups ?? [];
  const total = data?.total ?? 0;
  const products = data?.filterOptions.products ?? [];

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
      const url = withCompany(`/api/reports/legacy-gap?${buildParams({ all: true }).toString()}`, companyScope.selected);
      const res = await fetch(url);
      const d: LegacyGapResponse = await res.json();
      const exportRows = d.rows.map((r) => ({
        ...r,
        legacyType: TYPE_LABELS[r.legacyType] ?? r.legacyType,
        replacementFullTitle: r.replacementDefined ? r.replacementFullTitle : "No replacement",
        legacyCompletedDate: formatDate(r.legacyCompletedDate),
        legacyExpiryDate: formatDate(r.legacyExpiryDate),
        legacyActive: r.legacyActive ? "Yes" : "No",
      }));
      if (fmt === "csv") exportToCsv(exportRows as never, exportColumns as never, "legacy-replacement-gap");
      else if (fmt === "excel") exportToExcel(exportRows as never, exportColumns as never, "legacy-replacement-gap");
      else exportToPdf(exportRows as never, exportColumns as never, "legacy-replacement-gap");
    } finally {
      setExporting(false);
    }
  };

  if (loading && !data) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>;
  }

  const renderRow = (row: LegacyGapRow, idx: number) => (
    <tr key={`${row.email}-${row.legacyTrainingTitle}-${idx}`} className="border-b hover:bg-gray-50">
      <td className="px-4 py-3">{row.fullName}</td>
      <td className="px-4 py-3">{row.email}</td>
      <td className="px-4 py-3">{row.theatre || "-"}</td>
      <td className="px-4 py-3">{row.region || "-"}</td>
      <td className="px-4 py-3">{row.country || "-"}</td>
      <td className="px-4 py-3">{row.legacyFullTitle}</td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${typeBadgeClass(row.legacyType)}`}>
          {TYPE_LABELS[row.legacyType] ?? row.legacyType}
        </span>
      </td>
      <td className="px-4 py-3">{row.productType}</td>
      <td className="px-4 py-3">
        {row.replacementDefined ? (
          <span>
            {row.replacementFullTitle}
            {row.replacementState === "expired-only" && (
              <span className="ml-1 text-xs text-amber-600">(held, expired)</span>
            )}
          </span>
        ) : (
          <span className="text-gray-400">No replacement</span>
        )}
      </td>
      <td className="px-4 py-3">{formatDate(row.legacyCompletedDate)}</td>
      <td className="px-4 py-3">{formatDate(row.legacyExpiryDate)}</td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${row.legacyActive ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
          {row.legacyActive ? "Active" : "Expired"}
        </span>
      </td>
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
            <td colSpan={13} className="px-4 py-8 text-center text-gray-500">No legacy-replacement gaps found for the selected filters.</td>
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
          <td colSpan={13} className="px-4 py-2">Subtotal — {n} gap{n !== 1 ? "s" : ""}</td>
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
            <td colSpan={13} className="px-4 py-2">
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
      <PageHeader title="Legacy Replacement Gap" helpSlug="reports" />

      <KpiStrip
        cards={[
          { label: "Gaps", value: kpis.total, icon: History, tone: "blue" },
          { label: "Legacy Expired", value: kpis.expired, icon: AlertCircle, tone: "red" },
          { label: "Expiring ≤ 3 months", value: kpis.soon, icon: AlertTriangle, tone: "amber" },
          { label: "No Replacement", value: kpis.noReplacement, icon: Ban, tone: "indigo" },
        ]}
      />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">Legacy Expiry Horizon</h3>
            {filterHorizon && (
              <button onClick={() => setFilterHorizon(null)} className="text-xs text-blue-600 hover:underline">Clear horizon filter</button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={charts.horizonSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Bar dataKey="Certification" stackId="a" fill={chart.typeColor("Certification")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { horizonKey?: string }).horizonKey; if (k) setFilterHorizon(k); }) as never} />
              <Bar dataKey="Accreditation" stackId="a" fill={chart.typeColor("Accreditation")} cursor="pointer" onClick={((d: unknown) => { const k = (d as { horizonKey?: string }).horizonKey; if (k) setFilterHorizon(k); }) as never} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-400 mt-2">Buckets use the learner&apos;s legacy training expiry. Click a band to filter the table.</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Gaps by Product</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={charts.productSeries} layout="vertical" margin={{ left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Bar dataKey="gaps">
                {charts.productSeries.map((p) => (
                  <Cell key={p.name} fill={chart.productColor(p.name, productColors)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">Learners holding a legacy certification/accreditation without an active replacement</p>
          <span className="text-sm font-medium text-gray-500">{total} result{total !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" placeholder="Search by name, email, or training..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
              </div>
              <ExportMenu onExport={handleExport} busy={exporting} />
            </div>
            <div className="flex flex-wrap gap-3">
              <select value={filterWindow} onChange={(e) => setFilterWindow(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="all">All Expiries</option>
                <option value="expired">Already Expired</option>
                <option value="1">Expiring ≤ 1 Month</option>
                <option value="3">Expiring ≤ 3 Months</option>
                <option value="6">Expiring ≤ 6 Months</option>
                <option value="12">Expiring ≤ 12 Months</option>
              </select>
              <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Types</option>
                <option value="Certification">Certification</option>
                <option value="Accreditation">Accreditation</option>
              </select>
              <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">All Products</option>
                {products.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <GeoScopeFilter value={geo} onChange={setGeo} selectClassName="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" />
              <select value={groupBy ?? ""} onChange={(e) => setGroupBy((e.target.value as GroupByMode) || null)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">No Grouping</option>
                <option value="theatre">Group by Theatre</option>
                <option value="region">Group by Region</option>
                <option value="country">Group by Country</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-4 text-sm text-gray-600">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={includeNoReplacement} onChange={(e) => setIncludeNoReplacement(e.target.checked)} className="rounded border-gray-300" />
                Include legacy with no replacement
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={requireActive} onChange={(e) => setRequireActive(e.target.checked)} className="rounded border-gray-300" />
                Replacement must be active (off = any completion ever counts)
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
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("legacyFullTitle")}>Legacy Training{sortIndicator("legacyFullTitle")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("legacyType")}>Type{sortIndicator("legacyType")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("productType")}>Product{sortIndicator("productType")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("replacementFullTitle")}>Replacement{sortIndicator("replacementFullTitle")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("legacyCompletedDate")}>Completed{sortIndicator("legacyCompletedDate")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("legacyExpiryDate")}>Expires{sortIndicator("legacyExpiryDate")}</th>
                  <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("legacyActive")}>Status{sortIndicator("legacyActive")}</th>
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

export default function LegacyGapPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>}>
      <LegacyGapPageInner />
    </Suspense>
  );
}
