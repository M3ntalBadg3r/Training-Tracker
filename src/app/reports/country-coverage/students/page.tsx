"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import LoadingState from "@/components/ui/LoadingState";
import ExportMenu, { type ExportFormat } from "@/components/ui/ExportMenu";
import Pagination from "@/components/data-table/Pagination";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import { exportToCsv, exportToExcel } from "@/lib/export";
import { exportReportTablePdf } from "@/lib/report-export";

// Restated from lib/country-coverage-report.ts, which imports Prisma and so
// cannot be bundled for a client component.
type Metric = "headcount" | "people" | "held";
type Fn = "Sales" | "PreSales" | "Deployments" | "all";
type TypeFilter = "all" | "cert" | "accred";

interface StudentRow {
  fullName: string;
  email: string;
  country: string;
  held: number;
  trainings: string[];
}

interface RecordRow {
  fullName: string;
  email: string;
  country: string;
  training: string;
  trainingType: string;
  function: string;
  completedDate: string;
  expiryDate: string;
  active: boolean;
}

type DrilldownResponse =
  | { kind: "students"; rows: StudentRow[]; total: number; page: number; pageSize: number }
  | { kind: "records"; rows: RecordRow[]; total: number; page: number; pageSize: number };

const PAGE_SIZES = [25, 50, 100, 250];
const FN_LABELS: Record<Exclude<Fn, "all">, string> = { Sales: "Sales", PreSales: "Pre-Sales", Deployments: "Deployments" };
const TYPE_NOUNS: Record<TypeFilter, string> = {
  all: "certifications & accreditations",
  cert: "certifications",
  accred: "accreditations",
};

const STUDENT_COLUMNS = [
  { key: "fullName", label: "Name" },
  { key: "email", label: "Email" },
  { key: "country", label: "Country" },
  { key: "held", label: "Held" },
] as const;

const RECORD_COLUMNS = [
  { key: "fullName", label: "Name" },
  { key: "email", label: "Email" },
  { key: "country", label: "Country" },
  { key: "training", label: "Certification / Accreditation" },
  { key: "trainingType", label: "Type" },
  { key: "function", label: "Function" },
  { key: "completedDate", label: "Completed" },
  { key: "expiryDate", label: "Expires" },
] as const;

function parseMetric(v: string | null): Metric {
  return v === "people" || v === "held" ? v : "headcount";
}

function parseFn(v: string | null): Fn {
  return v === "Sales" || v === "PreSales" || v === "Deployments" ? v : "all";
}

function parseType(v: string | null): TypeFilter {
  return v === "cert" || v === "accred" ? v : "all";
}

function parseSize(v: string | null): number {
  const n = Number(v);
  return PAGE_SIZES.includes(n) ? n : 50;
}

function parsePage(v: string | null): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function CoverageStudentsInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const companyScope = useCompanyScope();
  const { formatDate } = useDateFormat();

  // The figure being drilled into is fixed by the link that opened the page,
  // so it is read once; only the list's own sort and paging change here.
  const [figure] = useState(() => ({
    metric: parseMetric(searchParams.get("metric")),
    fn: parseFn(searchParams.get("fn")),
    type: parseType(searchParams.get("type")),
    includeInactive: searchParams.get("includeInactive") === "true",
    noTheatre: searchParams.get("noTheatre") === "true",
    theatre: searchParams.get("theatre") ?? "",
    region: searchParams.get("region") ?? "",
    country: searchParams.get("country") ?? "",
    back: searchParams.get("back") ?? "",
  }));
  const columns = figure.metric === "held" ? RECORD_COLUMNS : STUDENT_COLUMNS;
  const [sortKey, setSortKey] = useState<string>(() => {
    const key = searchParams.get("sort") ?? "";
    return columns.some((c) => c.key === key) ? key : "fullName";
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => (searchParams.get("sortDir") === "desc" ? "desc" : "asc"));
  const [page, setPage] = useState(() => parsePage(searchParams.get("page")));
  const [pageSize, setPageSize] = useState(() => parseSize(searchParams.get("size")));

  // The figure's own params (the API request without sort/paging), in the
  // order the report writes them.
  const buildFigureParams = useCallback(() => {
    const params = new URLSearchParams();
    if (figure.noTheatre) params.set("noTheatre", "true");
    else if (figure.theatre) params.set("theatre", figure.theatre);
    if (figure.region) params.set("region", figure.region);
    if (figure.country) params.set("country", figure.country);
    if (figure.type !== "all") params.set("type", figure.type);
    if (figure.includeInactive) params.set("includeInactive", "true");
    params.set("metric", figure.metric);
    if (figure.fn !== "all") params.set("fn", figure.fn);
    return params;
  }, [figure]);

  const buildParams = useCallback(() => {
    const params = buildFigureParams();
    if (sortKey !== "fullName" || sortDir !== "asc") {
      params.set("sort", sortKey);
      params.set("sortDir", sortDir);
    }
    if (page !== 1) params.set("page", String(page));
    if (pageSize !== 50) params.set("size", String(pageSize));
    return params;
  }, [buildFigureParams, sortKey, sortDir, page, pageSize]);

  // Mirror the list view to the URL; `back` is carried through untouched.
  useEffect(() => {
    const params = buildParams();
    if (figure.back) params.set("back", figure.back);
    const qs = params.toString();
    if (qs !== searchParams.toString()) {
      router.replace(`${pathname}?${qs}`, { scroll: false });
    }
  }, [buildParams, figure.back, pathname, router, searchParams]);

  const query = buildParams().toString();
  const requestKey = companyScope.loading ? "__disabled__" : `${query}|sel:${companyScope.selected}`;
  const [loaded, setLoaded] = useState<{ key: string; data: DrilldownResponse | null; failed: boolean }>({
    key: "__init__",
    data: null,
    failed: false,
  });
  const loading = loaded.key !== requestKey;
  const data = loaded.data;

  useEffect(() => {
    if (companyScope.loading) return;
    const url = withCompany(`/api/reports/country-coverage/students?${query}`, companyScope.selected);
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: DrilldownResponse) => {
        if (!cancelled) setLoaded({ key: requestKey, data: d, failed: false });
      })
      .catch(() => {
        if (!cancelled) setLoaded((prev) => ({ ...prev, key: requestKey, failed: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, query, companyScope.loading, companyScope.selected]);

  // The server clamps a page past the end; adopt its answer.
  if (data && !loading && data.page !== page && data.total > 0) {
    setPage(data.page);
  }

  // ── Labels ────────────────────────────────────────────────────────────────
  const scopeLabel = figure.country
    ? figure.country
    : [figure.noTheatre ? "Countries with no theatre" : figure.theatre || "All theatres", figure.region]
        .filter(Boolean)
        .join(" · ");
  const noun = TYPE_NOUNS[figure.type];
  const fnLabel = figure.fn === "all" ? "" : `${FN_LABELS[figure.fn]} `;
  const title =
    figure.metric === "headcount"
      ? `Students — ${scopeLabel}`
      : figure.metric === "people"
        ? `People holding ${fnLabel}${noun} — ${scopeLabel}`
        : `${fnLabel}${noun} held — ${scopeLabel}`.replace(/^./, (c) => c.toUpperCase());
  const description =
    (figure.includeInactive ? "Counting active and expired " : "Counting active ") +
    noun +
    (figure.metric === "headcount"
      ? ". Every student in scope, with how many they hold."
      : figure.metric === "people"
        ? ". Each person once, with how many they hold."
        : ". One row per certification or accreditation held.");
  const backHref = `/reports/country-coverage${figure.back ? `?${figure.back}` : ""}`;

  // ── Sorting ───────────────────────────────────────────────────────────────
  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "held" || key === "completedDate" || key === "expiryDate" ? "desc" : "asc");
    }
    setPage(1);
  };
  const sortIndicator = (key: string) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  // ── Export ────────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const handleExport = async (fmt: ExportFormat) => {
    setExporting(true);
    try {
      const params = buildParams();
      params.delete("page");
      params.set("all", "true");
      const res = await fetch(withCompany(`/api/reports/country-coverage/students?${params.toString()}`, companyScope.selected));
      if (!res.ok) return;
      const all = (await res.json()) as DrilldownResponse;
      const exportColumns: { key: string; header: string }[] = [
        ...(all.kind === "records" ? RECORD_COLUMNS : STUDENT_COLUMNS).map((c) => ({ key: c.key, header: c.label })),
        all.kind === "records" ? { key: "status", header: "Status" } : { key: "trainings", header: "What they hold" },
      ];
      const exportRows: Record<string, string | number>[] =
        all.kind === "records"
          ? all.rows.map(({ active, ...r }) => ({
              ...r,
              completedDate: formatDate(r.completedDate),
              expiryDate: formatDate(r.expiryDate),
              status: active ? "Active" : "Expired",
            }))
          : all.rows.map((r) => ({ ...r, trainings: r.trainings.join("; ") }));
      const filename = `country-coverage-${figure.metric}${figure.fn !== "all" ? `-${figure.fn}` : ""}`;
      if (fmt === "csv") exportToCsv(exportRows as never, exportColumns as never, filename);
      else if (fmt === "excel") exportToExcel(exportRows as never, exportColumns as never, filename);
      else exportReportTablePdf({ title, filename, columns: exportColumns, rows: exportRows as never });
    } finally {
      setExporting(false);
    }
  };

  if (loading && !data) return <LoadingState label="Loading…" />;

  const total = data?.total ?? 0;

  return (
    <div>
      <PageHeader
        title={title}
        description={description}
        backHref={backHref}
        backLabel="Country Coverage by Function"
        helpSlug="reports-country-coverage"
        rightContent={<ExportMenu onExport={handleExport} busy={exporting} />}
      />

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">Click a name to open the student&rsquo;s record.</p>
          <span className="text-sm font-medium text-gray-500">
            {total.toLocaleString()} {figure.metric === "held" ? `record${total !== 1 ? "s" : ""}` : `${total !== 1 ? "people" : "person"}`}
          </span>
        </div>
        {loaded.failed && !data ? (
          <p className="px-6 py-8 text-center text-sm text-red-600">This list could not be loaded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      className={`px-3 py-2 font-semibold cursor-pointer select-none whitespace-nowrap ${c.key === "held" ? "text-right" : "text-left"}`}
                      onClick={() => toggleSort(c.key)}
                    >
                      {c.label}{sortIndicator(c.key)}
                    </th>
                  ))}
                  {data?.kind === "students" && <th className="px-3 py-2 text-left font-semibold">What they hold</th>}
                </tr>
              </thead>
              <tbody className={loading ? "opacity-60" : ""}>
                {data?.kind === "students" &&
                  data.rows.map((r) => (
                    <tr key={r.email} className="border-b hover:bg-gray-50 align-top">
                      <td className="px-3 py-2">
                        <Link href={`/students/${encodeURIComponent(r.email)}`} className="font-medium text-blue-600 hover:underline">
                          {r.fullName}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-gray-600">{r.email}</td>
                      <td className="px-3 py-2">{r.country}</td>
                      <td className="px-3 py-2 text-right">{r.held}</td>
                      <td className="px-3 py-2 text-gray-600">{r.trainings.length ? r.trainings.join(", ") : "—"}</td>
                    </tr>
                  ))}
                {data?.kind === "records" &&
                  data.rows.map((r) => (
                    <tr key={`${r.email}::${r.training}::${r.trainingType}`} className="border-b hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <Link href={`/students/${encodeURIComponent(r.email)}`} className="font-medium text-blue-600 hover:underline">
                          {r.fullName}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-gray-600">{r.email}</td>
                      <td className="px-3 py-2">{r.country}</td>
                      <td className="px-3 py-2">{r.training}</td>
                      <td className="px-3 py-2">{r.trainingType}</td>
                      <td className="px-3 py-2">{r.function}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatDate(r.completedDate)}</td>
                      <td className={`px-3 py-2 whitespace-nowrap ${r.active ? "" : "text-red-600"}`}>
                        {formatDate(r.expiryDate)}{r.active ? "" : " (expired)"}
                      </td>
                    </tr>
                  ))}
                {data && data.rows.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 1} className="px-4 py-8 text-center text-gray-500">
                      Nobody to show for this figure.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {total > 0 && (
          <div className="px-6 py-4 border-t border-gray-200">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              pageSizeOptions={PAGE_SIZES}
              onPageChange={setPage}
              onPageSizeChange={(n) => {
                setPageSize(n);
                setPage(1);
              }}
              itemLabel={figure.metric === "held" ? "records" : "people"}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default function CoverageStudentsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" />}>
      <CoverageStudentsInner />
    </Suspense>
  );
}
