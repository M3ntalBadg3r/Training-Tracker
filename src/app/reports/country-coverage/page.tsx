"use client";

import Link from "next/link";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import FilterBar from "@/components/ui/FilterBar";
import { SELECT_CLASS, CHECKBOX_LABEL_CLASS } from "@/components/ui/FormControls";
import LoadingState from "@/components/ui/LoadingState";
import KpiStrip from "@/components/ui/KpiStrip";
import ExportMenu, { type ExportFormat } from "@/components/ui/ExportMenu";
import GeoScopeFilter, { type GeoScope } from "@/components/reports/GeoScopeFilter";
import { ExportableChart, useChartCapture } from "@/components/reports/ChartCaptureProvider";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { useTableSort, type SortDir } from "@/hooks/useTableSort";
import { displayRegion } from "@/lib/group-by";
import { exportToCsv, exportToExcel } from "@/lib/export";
import { exportReportTablePdf } from "@/lib/report-export";
import { Map as MapIcon, Users, Award, UserCheck, Percent } from "lucide-react";
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// Restated from lib/country-coverage-report.ts, which imports Prisma and so
// cannot be bundled for a client component.
type TypeFilter = "all" | "cert" | "accred";

interface CoverageCounts {
  headcount: number;
  sales: number;
  preSales: number;
  deployments: number;
  total: number;
  peopleSales: number;
  peoplePreSales: number;
  peopleDeployments: number;
  people: number;
  coverage: number | null;
}

interface CoverageRow extends CoverageCounts {
  country: string;
  region: string;
  theatre: string;
}

interface CoverageGroup extends CoverageCounts {
  theatre: string;
  countries: number;
}

interface CoverageResponse {
  rows: CoverageRow[];
  groups: CoverageGroup[];
  totals: CoverageCounts & { countries: number };
}

const TYPE_OPTIONS: { value: TypeFilter; label: string; noun: string }[] = [
  { value: "all", label: "Certifications & accreditations", noun: "Certifications & accreditations" },
  { value: "cert", label: "Certifications only", noun: "Certifications" },
  { value: "accred", label: "Accreditations only", noun: "Accreditations" },
];

const FUNCTIONS = [
  { label: "Sales", fn: "Sales", count: "sales", people: "peopleSales" },
  { label: "Pre-Sales", fn: "PreSales", count: "preSales", people: "peoplePreSales" },
  { label: "Deployments", fn: "Deployments", count: "deployments", people: "peopleDeployments" },
] as const;

/** The geography a clicked figure covers: one country, a theatre subtotal, or the grand total. */
type CellScope = { theatre?: string; noTheatre?: boolean; region?: string; country?: string };

/** How many countries the stacked chart draws before it stops being readable. */
const CHART_MAX_COUNTRIES = 20;

const NUMERIC_KEYS = [
  "headcount", "sales", "preSales", "deployments", "total",
  "peopleSales", "peoplePreSales", "peopleDeployments", "people", "coverage",
] as const;

const SORT_ACCESSORS: Record<string, (r: CoverageRow) => string | number | null> = {
  country: (r) => r.country,
  region: (r) => displayRegion(r.region),
  ...Object.fromEntries(NUMERIC_KEYS.map((k) => [k, (r: CoverageRow) => r[k]])),
};

function parseTypeFilter(v: string | null): TypeFilter {
  return v === "cert" || v === "accred" ? v : "all";
}

function coverageText(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

function CountryCoverageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const chart = useChartTheme();
  const companyScope = useCompanyScope();

  // Seeded from the URL, using the same param names `buildParams` writes.
  const [geo, setGeo] = useState<GeoScope>(() => ({
    theatre: searchParams.get("theatre") ?? "",
    region: searchParams.get("region") ?? "",
    country: searchParams.get("country") ?? "",
  }));
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(() => parseTypeFilter(searchParams.get("type")));
  const [includeInactive, setIncludeInactive] = useState(() => searchParams.get("includeInactive") === "true");
  const [urlSort] = useState(() => ({
    key: searchParams.get("sort") ?? "",
    dir: (searchParams.get("sortDir") === "desc" ? "desc" : "asc") as SortDir,
  }));

  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    if (geo.theatre) params.set("theatre", geo.theatre);
    if (geo.region) params.set("region", geo.region);
    if (geo.country) params.set("country", geo.country);
    if (typeFilter !== "all") params.set("type", typeFilter);
    if (includeInactive) params.set("includeInactive", "true");
    return params;
  }, [geo, typeFilter, includeInactive]);

  // Derived loading (loaded.key !== requestKey) so a control change re-shows
  // the spinner without a set-state-in-effect violation.
  const query = buildParams().toString();
  const requestKey = companyScope.loading ? "__disabled__" : `${query}|sel:${companyScope.selected}`;
  const [loaded, setLoaded] = useState<{ key: string; data: CoverageResponse | null }>({ key: "__init__", data: null });
  const loading = loaded.key !== requestKey;
  const data = loaded.data;

  useEffect(() => {
    if (companyScope.loading) return;
    const url = withCompany(`/api/reports/country-coverage?${query}`, companyScope.selected);
    let cancelled = false;
    fetch(url)
      .then((r) => r.json())
      .then((d: CoverageResponse) => {
        if (!cancelled) setLoaded({ key: requestKey, data: d });
      })
      .catch(() => {
        if (!cancelled) setLoaded((prev) => ({ ...prev, key: requestKey }));
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, query, companyScope.loading, companyScope.selected]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const groups = useMemo(() => data?.groups ?? [], [data]);
  const totals = data?.totals;

  const { sorted, sortKey, sortDir, toggleSort, sortIndicator } = useTableSort(rows, SORT_ACCESSORS, {
    // `Object.hasOwn`, not `in`: `?sort=constructor` satisfies `in` via the prototype.
    defaultKey: Object.hasOwn(SORT_ACCESSORS, urlSort.key) ? urlSort.key : "country",
    defaultDir: urlSort.dir,
    tiebreakKey: "country",
    descFirstKeys: [...NUMERIC_KEYS],
  });

  // Mirror the view to the URL — the API query plus the client-side sort.
  useEffect(() => {
    const params = buildParams();
    if (sortKey !== "country" || sortDir !== "asc") {
      params.set("sort", sortKey);
      params.set("sortDir", sortDir);
    }
    const qs = params.toString();
    if (qs !== searchParams.toString()) {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [buildParams, sortKey, sortDir, pathname, router, searchParams]);

  // Rows sorted within each theatre, theatres in the server's order. A single
  // theatre renders as one flat table with no group header.
  const grouped = useMemo(() => {
    const byTheatre = new Map<string, CoverageRow[]>();
    for (const r of sorted) {
      const list = byTheatre.get(r.theatre) ?? [];
      list.push(r);
      byTheatre.set(r.theatre, list);
    }
    return groups.map((g) => ({ group: g, rows: byTheatre.get(g.theatre) ?? [] }));
  }, [sorted, groups]);
  const showGroups = grouped.length > 1;

  const noun = TYPE_OPTIONS.find((t) => t.value === typeFilter)?.noun ?? "Certifications & accreditations";

  const countryChart = useMemo(
    () =>
      [...rows]
        .filter((r) => r.total > 0)
        .sort((a, b) => b.total - a.total || a.country.localeCompare(b.country))
        .slice(0, CHART_MAX_COUNTRIES)
        .map((r) => ({ country: r.country, Sales: r.sales, "Pre-Sales": r.preSales, Deployments: r.deployments })),
    [rows]
  );
  const countriesWithData = rows.filter((r) => r.total > 0).length;
  const functionSplit = useMemo(
    () =>
      totals
        ? FUNCTIONS.map((f) => ({ name: f.label, value: totals[f.count] })).filter((d) => d.value > 0)
        : [],
    [totals]
  );

  // ── Export ────────────────────────────────────────────────────────────────
  const exportColumns = [
    { key: "theatre", header: "Theatre" },
    { key: "country", header: "Country" },
    { key: "region", header: "Region" },
    { key: "headcount", header: "Headcount" },
    ...FUNCTIONS.map((f) => ({ key: f.count, header: `${noun} – ${f.label}` })),
    { key: "total", header: `${noun} – Total` },
    ...FUNCTIONS.map((f) => ({ key: f.people, header: `People – ${f.label}` })),
    { key: "people", header: "People – Any function" },
    { key: "coverage", header: "Coverage %" },
  ];

  const toExportRow = (r: CoverageCounts, labels: { theatre: string; country: string; region: string }) => ({
    ...labels,
    headcount: r.headcount,
    sales: r.sales,
    preSales: r.preSales,
    deployments: r.deployments,
    total: r.total,
    peopleSales: r.peopleSales,
    peoplePreSales: r.peoplePreSales,
    peopleDeployments: r.peopleDeployments,
    people: r.people,
    coverage: r.coverage === null ? "" : r.coverage.toFixed(1),
  });

  const { capturePageVisuals } = useChartCapture();
  const [exporting, setExporting] = useState(false);

  const handleExport = async (fmt: ExportFormat, { includeCharts }: { includeCharts: boolean }) => {
    const exportRows: Record<string, string | number>[] = [];
    for (const { group, rows: groupRows } of grouped) {
      for (const r of groupRows) {
        exportRows.push(toExportRow(r, { theatre: r.theatre, country: r.country, region: displayRegion(r.region) }));
      }
      if (showGroups) {
        exportRows.push(toExportRow(group, { theatre: group.theatre, country: `${group.theatre || "No theatre"} total`, region: "" }));
      }
    }
    if (totals && rows.length > 0) {
      exportRows.push(toExportRow(totals, { theatre: "", country: "Total", region: "" }));
    }
    const filename = `country-coverage${geo.theatre ? `-${geo.theatre}` : ""}`;
    if (fmt === "csv") exportToCsv(exportRows as never, exportColumns as never, filename);
    else if (fmt === "excel") exportToExcel(exportRows as never, exportColumns as never, filename);
    else {
      setExporting(true);
      try {
        exportReportTablePdf({
          title: "Country Coverage by Function",
          filename,
          columns: exportColumns,
          rows: exportRows as never,
          meta: [
            { label: "Theatre", value: geo.theatre || "All theatres" },
            ...(geo.region ? [{ label: "Region", value: geo.region }] : []),
            ...(geo.country ? [{ label: "Country", value: geo.country }] : []),
            { label: "Counting", value: TYPE_OPTIONS.find((t) => t.value === typeFilter)?.label ?? "" },
            { label: "Expired", value: includeInactive ? "Included" : "Excluded (active only)" },
          ],
          ...(includeCharts ? await capturePageVisuals() : {}),
        });
      } finally {
        setExporting(false);
      }
    }
  };

  if (loading && !data) {
    return <LoadingState label="Loading report…" />;
  }

  const th = (key: string, label: string, align: "left" | "right" = "right") => (
    <th
      className={`px-3 py-2 font-semibold cursor-pointer select-none whitespace-nowrap ${align === "left" ? "text-left" : "text-right"}`}
      onClick={() => toggleSort(key)}
    >
      {label}{sortIndicator(key)}
    </th>
  );

  // Every non-zero figure links to the people (or the completions) behind it.
  // The list page takes the same filters as this report plus the cell's scope,
  // and `back` carries this page's own query so its back link restores the view.
  const drillHref = (scope: CellScope, metric: "headcount" | "people" | "held", fn?: string) => {
    const params = new URLSearchParams();
    if (scope.noTheatre) params.set("noTheatre", "true");
    else if (scope.theatre) params.set("theatre", scope.theatre);
    if (scope.region) params.set("region", scope.region);
    if (scope.country) params.set("country", scope.country);
    if (typeFilter !== "all") params.set("type", typeFilter);
    if (includeInactive) params.set("includeInactive", "true");
    params.set("metric", metric);
    if (fn) params.set("fn", fn);
    params.set("back", searchParams.toString());
    return `/reports/country-coverage/students?${params.toString()}`;
  };

  const figure = (value: number, href: string, title: string) =>
    value > 0 ? (
      <Link href={href} title={title} className="text-blue-600 hover:underline">
        {value.toLocaleString()}
      </Link>
    ) : (
      value.toLocaleString()
    );

  const numberCells = (r: CoverageCounts, scope: CellScope) => (
    <>
      <td className="px-3 py-2 text-right">{figure(r.headcount, drillHref(scope, "headcount"), "View these students")}</td>
      {FUNCTIONS.map((f) => (
        <td key={f.count} className="px-3 py-2 text-right">
          {figure(r[f.count], drillHref(scope, "held", f.fn), `View these ${f.label} ${noun.toLowerCase()}`)}
        </td>
      ))}
      <td className="px-3 py-2 text-right font-semibold">
        {figure(r.total, drillHref(scope, "held"), `View these ${noun.toLowerCase()}`)}
      </td>
      {FUNCTIONS.map((f) => (
        <td key={f.people} className="px-3 py-2 text-right">
          {figure(r[f.people], drillHref(scope, "people", f.fn), `View the people holding ${f.label} ${noun.toLowerCase()}`)}
        </td>
      ))}
      <td className="px-3 py-2 text-right font-semibold">
        {figure(r.people, drillHref(scope, "people"), "View the people holding at least one")}
      </td>
      <td className="px-3 py-2 text-right">{coverageText(r.coverage)}</td>
    </>
  );

  const groupScope = (theatre: string): CellScope =>
    theatre ? { theatre, region: geo.region } : { noTheatre: true, region: geo.region };

  return (
    <div>
      <PageHeader
        title="Country Coverage by Function"
        description="Every country in a theatre, with certifications and accreditations held by function, how many people hold them and what share of the headcount that is."
        backHref="/reports"
        backLabel="Reports"
        helpSlug="reports-country-coverage"
        rightContent={<ExportMenu onExport={handleExport} busy={exporting} />}
      />

      <FilterBar>
        <FilterBar.Row>
          <GeoScopeFilter value={geo} onChange={setGeo} />
          <select value={typeFilter} onChange={(e) => setTypeFilter(parseTypeFilter(e.target.value))} className={SELECT_CLASS}>
            {TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <label className={CHECKBOX_LABEL_CLASS}>
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            Include expired (inactive)
          </label>
        </FilterBar.Row>
      </FilterBar>

      <KpiStrip
        cards={[
          { label: "Countries", value: totals?.countries ?? 0, icon: MapIcon, tone: "blue", hint: `${countriesWithData} with at least one held` },
          { label: "Headcount", value: (totals?.headcount ?? 0).toLocaleString(), icon: Users, tone: "indigo" },
          { label: "Total held", hint: noun, value: (totals?.total ?? 0).toLocaleString(), icon: Award, tone: "emerald" },
          { label: "People holding one", value: (totals?.people ?? 0).toLocaleString(), icon: UserCheck, tone: "green" },
          { label: "Coverage", value: coverageText(totals?.coverage ?? null), icon: Percent, tone: "amber", hint: "People holding ÷ headcount" },
        ]}
      />

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <ExportableChart className="lg:col-span-2 bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">{noun} by Country and Function</h3>
          {countryChart.length === 0 ? (
            <p className="text-sm text-gray-500 py-16 text-center">Nothing held in the selected scope.</p>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={countryChart}>
                <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
                <XAxis dataKey="country" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={70} interval={0} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
                <Tooltip contentStyle={tooltipStyle(chart)} />
                <Legend />
                {FUNCTIONS.map((f, i) => (
                  <Bar key={f.label} dataKey={f.label} stackId="a" fill={chart.series(i)} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
          {countriesWithData > CHART_MAX_COUNTRIES && (
            <p className="text-xs text-gray-400 mt-2">
              Showing the top {CHART_MAX_COUNTRIES} of {countriesWithData} countries by total; the table lists them all.
            </p>
          )}
        </ExportableChart>
        <ExportableChart className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Split by Function</h3>
          {functionSplit.length === 0 ? (
            <p className="text-sm text-gray-500 py-16 text-center">Nothing held in the selected scope.</p>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <PieChart>
                <Pie data={functionSplit} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
                  {functionSplit.map((s) => (
                    <Cell key={s.name} fill={chart.series(FUNCTIONS.findIndex((f) => f.label === s.name))} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle(chart)} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ExportableChart>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">
            {includeInactive ? "Counting active and expired" : "Counting active"} {noun.toLowerCase()}. A person holding
            {" "}{noun.toLowerCase()} in more than one function is counted under each, but once under &ldquo;Any&rdquo;.
            Click a figure to see the people behind it.
          </p>
          <span className="text-sm font-medium text-gray-500">{rows.length} countr{rows.length !== 1 ? "ies" : "y"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <th colSpan={3} />
                <th colSpan={4} className="px-3 pt-2 text-center border-l border-gray-200">{noun} held</th>
                <th colSpan={4} className="px-3 pt-2 text-center border-l border-gray-200">People holding</th>
                <th className="border-l border-gray-200" />
              </tr>
              <tr className="bg-gray-50 border-b">
                {th("country", "Country", "left")}
                {th("region", "Region", "left")}
                {th("headcount", "Headcount")}
                {th("sales", "Sales")}
                {th("preSales", "Pre-Sales")}
                {th("deployments", "Deployments")}
                {th("total", "Total")}
                {th("peopleSales", "Sales")}
                {th("peoplePreSales", "Pre-Sales")}
                {th("peopleDeployments", "Deployments")}
                {th("people", "Any")}
                {th("coverage", "Coverage")}
              </tr>
            </thead>
            <tbody>
              {grouped.map(({ group, rows: groupRows }) => (
                <Fragment key={group.theatre || "__none__"}>
                  {showGroups && (
                    <tr className="bg-blue-50 border-b">
                      <td colSpan={12} className="px-3 py-2 font-semibold text-blue-900">
                        {group.theatre || "No theatre"}{" "}
                        <span className="font-normal text-blue-700">· {group.countries} countr{group.countries !== 1 ? "ies" : "y"}</span>
                      </td>
                    </tr>
                  )}
                  {groupRows.map((r) => (
                    <tr key={r.country} className={`border-b hover:bg-gray-50 ${r.headcount === 0 ? "text-gray-400" : ""}`}>
                      <td className="px-3 py-2 font-medium">{r.country}</td>
                      <td className="px-3 py-2">{displayRegion(r.region)}</td>
                      {numberCells(r, { country: r.country })}
                    </tr>
                  ))}
                  {showGroups && (
                    <tr className="border-b bg-gray-50 font-medium">
                      <td className="px-3 py-2" colSpan={2}>{group.theatre || "No theatre"} total</td>
                      {numberCells(group, groupScope(group.theatre))}
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={12} className="px-4 py-8 text-center text-gray-500">No countries match the selected scope.</td></tr>
              )}
            </tbody>
            {totals && rows.length > 0 && (
              <tfoot>
                <tr className="bg-gray-100 border-t font-semibold">
                  <td className="px-3 py-2" colSpan={2}>Total</td>
                  {numberCells(totals, geo)}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

export default function CountryCoveragePage() {
  return (
    <Suspense fallback={<LoadingState label="Loading report…" />}>
      <CountryCoverageInner />
    </Suspense>
  );
}
