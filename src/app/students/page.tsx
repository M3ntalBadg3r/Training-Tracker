"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import LoadingState from "@/components/ui/LoadingState";
import Modal from "@/components/ui/Modal";
import Pagination from "@/components/data-table/Pagination";
import SearchInput, { SELECT_CLASS } from "@/components/ui/FormControls";
import { useAuth } from "@/components/auth/AuthProvider";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useRegionData } from "@/hooks/useRegionData";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useDebounce } from "@/hooks/useDebounce";
import { displayRegion } from "@/lib/group-by";
import {
  STUDENT_FILTER_KEYS,
  STUDENT_PAGE_SIZES,
  buildStudentListParams,
  parseStudentListQuery,
  type StudentFilterKey,
  type StudentFilterOptions,
  type StudentFilters,
  type StudentListQuery,
  type StudentListResponse,
  type StudentListRow,
  type StudentSearchColumn,
  type StudentSortKey,
} from "@/lib/students-list-params";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";

interface CompanyOption { id: number; name: string }

interface ListColumn {
  key: StudentSortKey;
  header: string;
  /** Offers an exact-match filter dropdown under the header. */
  filter?: StudentFilterKey;
}

function cellValue(row: StudentListRow, key: StudentSortKey): string {
  if (key === "companyName") return row.companyName ?? "";
  // A country with no region defined shows an empty cell.
  if (key === "region") return displayRegion(row.region);
  return row[key] ?? "";
}

function optionListFor(options: StudentFilterOptions, key: StudentFilterKey): string[] | null {
  if (key === "theatre") return options.theatres;
  if (key === "region") return options.regions;
  if (key === "country") return options.countries;
  return options.companies;
}

/**
 * The student list is searched, filtered, sorted and paged on the server
 * (`GET /api/students`, `lib/students-list.ts`), so the browser only ever
 * holds one page of rows. The view is mirrored to the URL with the names the
 * old client-side DataTable used (`q`/`qCol`/`sort`/`sortDir`/`f_<col>`/
 * `page`/`size`), built and parsed by the shared `lib/students-list-params.ts`
 * so the address bar and the request cannot drift — opening a student and
 * pressing Back restores the exact view.
 */
function StudentsPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAdmin } = useAuth();
  const companyScope = useCompanyScope();

  // Seed every piece of view state from the URL once, on mount. The parser
  // re-validates each value (allow-listed keys, fixed page sizes, positive page).
  const [seed] = useState(() => parseStudentListQuery(searchParams));
  const [search, setSearch] = useState(seed.q);
  const debouncedSearch = useDebounce(search, 300);
  const [searchColumn, setSearchColumn] = useState<StudentSearchColumn>(seed.qCol);
  const [sortColumn, setSortColumn] = useState<StudentSortKey>(seed.sort);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">(seed.sortDir);
  const [filters, setFilters] = useState<StudentFilters>(seed.filters);
  const [page, setPage] = useState(seed.page);
  const [pageSize, setPageSize] = useState(seed.pageSize);

  const scopeReady = !companyScope.loading;
  // The "Company" column is only visible when the global switcher is set to "All"
  // (otherwise every row has the same company value, which adds visual noise).
  const showCompanyColumn = companyScope.selected === "all";

  // Filter dropdown values for the current scope: distinct values computed in
  // SQL, never derived from a download of every student.
  const optionsUrl = scopeReady
    ? withCompany("/api/students?options=true", companyScope.selected)
    : null;
  const {
    data: optionsData,
    loading: optionsLoading,
    error: optionsError,
    reload: reloadOptions,
  } = useFetchJson<{ filterOptions: StudentFilterOptions }>(optionsUrl);
  // Only trust options that belong to the current scope (useFetchJson keeps the
  // previous payload while the next one is in flight).
  const options = optionsData && !optionsLoading && !optionsError ? optionsData.filterOptions : null;

  // Re-validate against what the page can actually show. Derived, not written
  // back into state: a column that is hidden in a single-company view cannot be
  // searched, sorted or filtered by, and a filter value the scope does not
  // contain would only ever park the page on an empty table.
  const effectiveSearchColumn: StudentSearchColumn =
    searchColumn === "companyName" && !showCompanyColumn ? "all" : searchColumn;
  const sortHidden = sortColumn === "companyName" && !showCompanyColumn;
  const effectiveSortColumn: StudentSortKey = sortHidden ? "fullName" : sortColumn;
  const effectiveSortDirection: "asc" | "desc" = sortHidden ? "asc" : sortDirection;
  const effectiveFilters = useMemo<StudentFilters>(() => {
    const out: StudentFilters = {};
    for (const key of STUDENT_FILTER_KEYS) {
      const value = filters[key];
      if (!value) continue;
      if (key === "companyName" && !showCompanyColumn) continue;
      const list = options ? optionListFor(options, key) : null;
      if (list) {
        // Land on one of the dropdown's own options (case-insensitively, as the
        // server matches), or drop the filter.
        const match = list.find((o) => o.toLowerCase() === value.toLowerCase());
        if (match) out[key] = match;
        continue;
      }
      // Options not loaded yet, or too many companies to list: keep the value.
      out[key] = value;
    }
    return out;
  }, [filters, options, showCompanyColumn]);

  const viewQuery = useMemo<StudentListQuery>(
    () => ({
      q: debouncedSearch.trim(),
      qCol: effectiveSearchColumn,
      sort: effectiveSortColumn,
      sortDir: effectiveSortDirection,
      filters: effectiveFilters,
      page,
      pageSize,
    }),
    [debouncedSearch, effectiveSearchColumn, effectiveSortColumn, effectiveSortDirection, effectiveFilters, page, pageSize]
  );

  // Reset to page 1 when the search, a filter, the sort or the company scope
  // changes — but not for the first settled view, so a URL-seeded page
  // survives back-navigation. The key is null until the company scope has
  // resolved, because the provider reports "all" while loading and then moves
  // to the persisted company, which is not a user change.
  //
  // Done while rendering (the "adjust state while rendering" pattern) rather
  // than in an effect: an effect would run after the fetch for the new search
  // had already gone out with the old page number, wasting a request per
  // change. `lastResetKey === null` is the mount guard (a didMountRef).
  const resetKey = scopeReady
    ? JSON.stringify([debouncedSearch.trim(), searchColumn, sortColumn, sortDirection, filters, companyScope.selected])
    : null;
  const [lastResetKey, setLastResetKey] = useState<string | null>(null);
  if (resetKey !== null && resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    if (lastResetKey !== null && page !== 1) setPage(1);
  }

  // Mirror the view to the URL. The search box's own text is written (not the
  // debounced copy) so the address bar keeps up with typing, as on the reports.
  useEffect(() => {
    const qs = buildStudentListParams({ ...viewQuery, q: search.trim() }).toString();
    if (qs !== searchParams.toString()) {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [viewQuery, search, searchParams, pathname, router]);

  // Both loads go through useFetchJson, whose `loading` is derived
  // (loadedKey !== requestKey) rather than written by a synchronous setState
  // inside an effect. A null url parks the hook in its loading state while the
  // company scope is still resolving — and, when a column filter is set, until
  // that scope's options have answered, so the first request already carries
  // the re-validated filters (otherwise a stale value would be fetched, and the
  // server's page clamp applied to a view the page is about to discard).
  const filtersSettled = Object.keys(filters).length === 0 || (optionsUrl !== null && !optionsLoading);
  const studentsUrl = scopeReady && filtersSettled
    ? withCompany(`/api/students?${buildStudentListParams(viewQuery).toString()}`, companyScope.selected)
    : null;
  const {
    data: studentsData,
    loading,
    error: studentsError,
    reload: reloadStudents,
  } = useFetchJson<StudentListResponse>(studentsUrl);
  const rows = studentsData?.rows ?? [];
  const total = studentsData?.total ?? 0;

  // The server clamps a page past the end (a stale link, rows deleted since) to
  // the last page; adopt that so the pager and the URL agree with the table.
  // "Adjust state while rendering" rather than an effect.
  if (studentsData && !loading && !studentsError && studentsData.page !== page) {
    setPage(studentsData.page);
  }

  // Show the last import for the selected company; system-wide under "All".
  const importKey =
    companyScope.selected === "all" ? "students" : `students:${companyScope.selected}`;
  const { data: importMeta } = useFetchJson<{ timestamp?: string | null }>(
    companyScope.loading ? null : `/api/import-metadata?key=${encodeURIComponent(importKey)}`
  );
  const lastImport = importMeta?.timestamp ?? null;
  const { rows: countries } = useRegionData();

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    email: "",
    fullName: "",
    country: "",
    companyId: "" as number | "",
  });
  const [addError, setAddError] = useState("");
  const [saving, setSaving] = useState(false);

  // Only countries with a populated theatre are eligible for new students.
  const selectableCountries = useMemo(
    () => countries.filter((c) => !!c.theatre),
    [countries]
  );
  const selectedCountry = useMemo(
    () => selectableCountries.find((c) => c.country === addForm.country) ?? null,
    [selectableCountries, addForm.country]
  );

  const columns: ListColumn[] = [
    { key: "fullName", header: "Full Name" },
    { key: "email", header: "Email Address" },
    ...(showCompanyColumn
      ? [{ key: "companyName" as const, header: "Company", filter: "companyName" as const }]
      : []),
    { key: "theatre", header: "Theatre", filter: "theatre" },
    { key: "region", header: "Region", filter: "region" },
    { key: "country", header: "Country", filter: "country" },
  ];

  const handleSort = (key: StudentSortKey) => {
    if (effectiveSortColumn === key) {
      setSortColumn(key);
      setSortDirection(effectiveSortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(key);
      setSortDirection("asc");
    }
  };

  // Written from the effective values, so a value dropped by re-validation
  // cannot resurface on the next edit.
  const handleColumnFilter = (key: StudentFilterKey, value: string) => {
    setFilters({ ...effectiveFilters, [key]: value });
  };

  const filterOptionsFor = (key: StudentFilterKey): string[] => {
    const list = (options ? optionListFor(options, key) : null) ?? [];
    const current = effectiveFilters[key];
    // A value the dropdown does not list (options still loading, or a company
    // list too long to offer) is shown so it stays visible and clearable.
    return current && !list.includes(current) ? [current, ...list] : list;
  };

  const handleAddStudent = async () => {
    setAddError("");
    if (!addForm.companyId) {
      setAddError("Please select a company.");
      return;
    }
    if (!addForm.country) {
      setAddError("Please select a country.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: addForm.email,
          fullName: addForm.fullName,
          country: addForm.country,
          companyId: addForm.companyId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.error || "Failed to create student");
        return;
      }
      setShowAdd(false);
      setAddForm({ email: "", fullName: "", country: "", companyId: "" });
      reloadStudents();
      reloadOptions();
    } finally {
      setSaving(false);
    }
  };

  if (!studentsData && (loading || !scopeReady)) {
    return (
      <LoadingState label="Loading students…" />
    );
  }

  // Default the picker to the currently-selected company (when not "all"),
  // so adding a student in a single-company view is one click.
  const defaultCompanyForAdd = (): number | "" => {
    if (companyScope.selected !== "all") return companyScope.selected;
    if (companyScope.companies.length === 1) return companyScope.companies[0].id;
    return "";
  };

  const actionColSpan = columns.length + 1;

  return (
    <div>
      <PageHeader
        title="Students"
        helpSlug="students"
        rightContent={
          <div className="flex items-center gap-4">
            {lastImport && (
              <span className="text-sm text-gray-500">
                Last imported: {new Date(lastImport).toLocaleString()}
              </span>
            )}
            {isAdmin && (
              <button
                onClick={() => {
                  setAddError("");
                  setAddForm({
                    email: "",
                    fullName: "",
                    country: "",
                    companyId: defaultCompanyForAdd(),
                  });
                  setShowAdd(true);
                }}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
              >
                <Plus size={16} /> Add Student
              </button>
            )}
          </div>
        }
      />
      <div className="space-y-4">
        {/* Search bar */}
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search..."
            className="flex-1 max-w-md"
          />
          <select
            value={effectiveSearchColumn}
            onChange={(e) => setSearchColumn(e.target.value as StudentSearchColumn)}
            className={SELECT_CLASS}
            aria-label="Search column"
          >
            <option value="all">All columns</option>
            {columns.map((col) => (
              <option key={col.key} value={col.key}>
                {col.header}
              </option>
            ))}
          </select>
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className={`overflow-x-auto transition-opacity ${loading ? "opacity-60" : ""}`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {columns.map((col) => (
                    <th key={col.key} className="px-4 py-3 text-left align-top">
                      <div className="space-y-1">
                        <button
                          onClick={() => handleSort(col.key)}
                          className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900"
                        >
                          {col.header}
                          {effectiveSortColumn === col.key && (
                            effectiveSortDirection === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} />
                          )}
                        </button>
                        {col.filter && (
                          <select
                            value={effectiveFilters[col.filter] ?? ""}
                            onChange={(e) => handleColumnFilter(col.filter as StudentFilterKey, e.target.value)}
                            className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal"
                            aria-label={`Filter by ${col.header}`}
                          >
                            <option value="">All</option>
                            {filterOptionsFor(col.filter).map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </th>
                  ))}
                  <th className="px-4 py-3 text-left align-top font-semibold text-gray-700">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={actionColSpan} className="px-4 py-8 text-center text-gray-500">
                      {studentsError ? "Failed to load students." : "No records found"}
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row.email}
                      className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                    >
                      {columns.map((col) => (
                        <td key={col.key} className="px-4 py-3 text-gray-700">
                          {cellValue(row, col.key)}
                        </td>
                      ))}
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => router.push(`/students/${encodeURIComponent(row.email)}`)}
                            className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                          >
                            View
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pagination */}
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          pageSizeOptions={[...STUDENT_PAGE_SIZES]}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      </div>

      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add Student"
        actions={
          <>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button
              onClick={handleAddStudent}
              disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Creating..." : "Create Student"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
            <input
              type="text"
              value={addForm.fullName}
              onChange={(e) => setAddForm((f) => ({ ...f, fullName: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
            <input
              type="email"
              value={addForm.email}
              onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
            <select
              value={addForm.companyId === "" ? "" : String(addForm.companyId)}
              onChange={(e) =>
                setAddForm((f) => ({ ...f, companyId: e.target.value === "" ? "" : Number(e.target.value) }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">-- Select company --</option>
              {companyScope.companies.map((c: CompanyOption) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
            <select
              value={addForm.country}
              onChange={(e) => setAddForm((f) => ({ ...f, country: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">-- Select country --</option>
              {selectableCountries.map((c) => (
                <option key={c.country} value={c.country}>
                  {c.country}
                </option>
              ))}
            </select>
            {selectableCountries.length === 0 && (
              <p className="mt-1 text-xs text-amber-600">
                No countries with a theatre are configured. A SuperAdmin must add them in
                Region Data first.
              </p>
            )}
            <p className="mt-1 text-xs text-gray-500">
              Theatre and Region are auto-derived from Region Data. To add a new country,
              ask a SuperAdmin to create it on the Region Data page.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Theatre</label>
              <div className="w-full px-3 py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-700 min-h-[38px]">
                {selectedCountry?.theatre ?? <span className="text-gray-400">—</span>}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Region</label>
              <div className="w-full px-3 py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-700 min-h-[38px]">
                {displayRegion(selectedCountry?.region)}
              </div>
            </div>
          </div>
          {addError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{addError}</div>
          )}
        </div>
      </Modal>
    </div>
  );
}

export default function StudentsPage() {
  return (
    <Suspense
      fallback={
        <LoadingState label="Loading students…" />
      }
    >
      <StudentsPageInner />
    </Suspense>
  );
}
