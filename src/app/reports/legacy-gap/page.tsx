"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import GroupedRows from "@/components/data-table/GroupedRows";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { useProductTypeColors } from "@/hooks/useProductTypeColors";
import { groupRows, GroupByMode } from "@/lib/group-by";
import { useTableSort, SortAccessor } from "@/hooks/useTableSort";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import { Search, Download, ArrowLeft, History, AlertCircle, AlertTriangle, Ban } from "lucide-react";
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

const TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
};

function typeBadgeClass(t: string): string {
  if (t === "Certification") return "bg-blue-100 text-blue-800";
  return "bg-emerald-100 text-emerald-800";
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

const HORIZONS: { key: string; label: string }[] = [
  { key: "expired", label: "Expired" },
  { key: "0-1", label: "≤ 1 month" },
  { key: "1-3", label: "1–3 months" },
  { key: "3-6", label: "3–6 months" },
  { key: "6-12", label: "6–12 months" },
  { key: "12+", label: "12+ months" },
];

function monthsBetween(now: Date, future: Date): number {
  return (future.getFullYear() - now.getFullYear()) * 12 + (future.getMonth() - now.getMonth());
}

function bucketHorizon(expiry: Date, now: Date): string {
  if (expiry <= now) return "expired";
  const m = monthsBetween(now, expiry);
  if (m <= 1) return "0-1";
  if (m <= 3) return "1-3";
  if (m <= 6) return "3-6";
  if (m <= 12) return "6-12";
  return "12+";
}

export default function LegacyGapPage() {
  const router = useRouter();
  const chart = useChartTheme();
  const productColors = useProductTypeColors();
  const { formatDate } = useDateFormat();
  const companyScope = useCompanyScope();
  const { data: recordsData, loading } = useFetchJson<LegacyGapRow[]>(
    withCompany("/api/reports/legacy-gap", companyScope.selected),
    { enabled: !companyScope.loading }
  );
  const records = useMemo(() => recordsData ?? [], [recordsData]);

  const [search, setSearch] = useState("");
  const [filterWindow, setFilterWindow] = useState("all"); // all | expired | 1 | 3 | 6 | 12
  const [filterType, setFilterType] = useState("");
  const [filterProduct, setFilterProduct] = useState("");
  const [filterHorizon, setFilterHorizon] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupByMode | null>("theatre");

  // Two toggles from the report requirements:
  // - includeNoReplacement: show legacy trainings that have no replacement set.
  // - requireActive: a gap requires the absence of an ACTIVE replacement; when
  //   off ("any completion ever"), a held-but-expired replacement also clears.
  const [includeNoReplacement, setIncludeNoReplacement] = useState(true);
  const [requireActive, setRequireActive] = useState(true);

  const now = useMemo(() => new Date(), []);

  const products = useMemo(() => [...new Set(records.map((r) => r.productType))].filter(Boolean).sort(), [records]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return records.filter((r) => {
      if (!includeNoReplacement && !r.replacementDefined) return false;
      // Under the "any completion ever" rule a held-but-expired replacement
      // counts as satisfied, so drop those rows.
      if (!requireActive && r.replacementState === "expired-only") return false;
      if (search && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q) && !r.legacyFullTitle.toLowerCase().includes(q)) return false;
      if (filterType && r.legacyType !== filterType) return false;
      if (filterProduct && r.productType !== filterProduct) return false;

      const expiry = new Date(r.legacyExpiryDate);
      if (filterWindow === "expired") {
        if (expiry > now) return false;
      } else if (filterWindow !== "all") {
        const months = parseInt(filterWindow);
        const cutoff = new Date(now);
        cutoff.setMonth(cutoff.getMonth() + months);
        if (expiry <= now || expiry > cutoff) return false;
      }
      if (filterHorizon && bucketHorizon(expiry, now) !== filterHorizon) return false;
      return true;
    });
  }, [records, search, filterType, filterProduct, filterWindow, filterHorizon, includeNoReplacement, requireActive, now]);

  const horizonSeries = useMemo(() => {
    const counts: Record<string, { name: string; Certification: number; Accreditation: number; horizonKey: string }> = {};
    for (const h of HORIZONS) counts[h.key] = { name: h.label, Certification: 0, Accreditation: 0, horizonKey: h.key };
    for (const r of filtered) {
      const b = bucketHorizon(new Date(r.legacyExpiryDate), now);
      if (r.legacyType === "Accreditation") counts[b].Accreditation++;
      else counts[b].Certification++;
    }
    return HORIZONS.map((h) => counts[h.key]);
  }, [filtered, now]);

  const productSeries = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of filtered) map.set(r.productType, (map.get(r.productType) ?? 0) + 1);
    return [...map.entries()].map(([name, value]) => ({ name, gaps: value })).sort((a, b) => b.gaps - a.gaps).slice(0, 12);
  }, [filtered]);

  const kpis = useMemo(() => ({
    total: filtered.length,
    expired: filtered.filter((r) => !r.legacyActive).length,
    soon: filtered.filter((r) => { const b = bucketHorizon(new Date(r.legacyExpiryDate), now); return b === "0-1" || b === "1-3"; }).length,
    noReplacement: filtered.filter((r) => !r.replacementDefined).length,
  }), [filtered, now]);

  // Column sorting (applied before grouping so rows sort within each group).
  const sortAccessors: Record<string, SortAccessor<LegacyGapRow>> = {
    fullName: (r) => r.fullName,
    email: (r) => r.email,
    theatre: (r) => r.theatre,
    region: (r) => r.region,
    country: (r) => r.country,
    legacyFullTitle: (r) => r.legacyFullTitle,
    legacyType: (r) => r.legacyType,
    productType: (r) => r.productType,
    replacementFullTitle: (r) => (r.replacementDefined ? r.replacementFullTitle : ""),
    legacyCompletedDate: (r) => r.legacyCompletedDate,
    legacyExpiryDate: (r) => r.legacyExpiryDate,
    legacyActive: (r) => r.legacyActive,
  };
  const { sorted, toggleSort, sortIndicator } = useTableSort(filtered, sortAccessors, {
    defaultKey: "fullName",
    tiebreakKey: "fullName",
  });

  const grouped = useMemo(() => groupRows(sorted, groupBy ?? "theatre"), [sorted, groupBy]);

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
  const exportRows = filtered.map((r) => ({
    ...r,
    legacyType: TYPE_LABELS[r.legacyType] ?? r.legacyType,
    replacementFullTitle: r.replacementDefined ? r.replacementFullTitle : "No replacement",
    legacyCompletedDate: formatDate(r.legacyCompletedDate),
    legacyExpiryDate: formatDate(r.legacyExpiryDate),
    legacyActive: r.legacyActive ? "Yes" : "No",
  }));

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
            <BarChart data={horizonSeries}>
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
            <BarChart data={productSeries} layout="vertical" margin={{ left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Bar dataKey="gaps">
                {productSeries.map((p) => (
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
          <span className="text-sm font-medium text-gray-500">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" placeholder="Search by name, email, or training..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
              </div>
              <ExportMenu data={exportRows as never} columns={exportColumns} filename="legacy-replacement-gap" />
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
              <GroupedRows
                groups={grouped}
                groupBy={groupBy}
                colSpanTotal={13}
                emptyMessage="No legacy-replacement gaps found for the selected filters."
                renderRow={(row, idx) => (
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
                )}
                renderSubtotal={(g) => (
                  <td colSpan={13} className="px-4 py-2">
                    Subtotal — {g.rows.length} gap{g.rows.length !== 1 ? "s" : ""}
                  </td>
                )}
              />
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
