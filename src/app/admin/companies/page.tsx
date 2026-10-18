"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import LoadingState from "@/components/ui/LoadingState";
import SearchInput from "@/components/ui/FormControls";
import Pagination from "@/components/data-table/Pagination";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";
import { Plus, Pencil, Trash2, Building2, ChevronDown, ChevronUp } from "lucide-react";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useDebounce } from "@/hooks/useDebounce";
import {
  COMPANY_PAGE_SIZES,
  buildCompanyListParams,
  cleanCompanySearch,
  parseCompanyListQuery,
  type CompanyListQuery,
  type CompanyListResponse,
  type CompanyListRow,
  type CompanySortKey,
} from "@/lib/companies-list-params";

type CompanyRow = CompanyListRow;

/**
 * The company list is searched, sorted and paged on the server
 * (`GET /api/admin/companies`, `lib/companies-list.ts`), so the browser only
 * ever holds one page of rows — an install may carry tens of thousands of
 * companies. The view (`q`/`sort`/`sortDir`/`page`/`size`) is mirrored to the
 * URL, built and parsed by the shared `lib/companies-list-params.ts` so the
 * address bar and the request cannot drift.
 */
function CompaniesPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const companyScope = useCompanyScope();

  // Seed every piece of view state from the URL once, on mount. The parser
  // re-validates each value (allow-listed sort keys, fixed page sizes,
  // positive page, capped search text).
  const [seed] = useState(() => parseCompanyListQuery(searchParams));
  const [search, setSearch] = useState(seed.q);
  const debouncedSearch = useDebounce(search, 300);
  const [sort, setSort] = useState<CompanySortKey>(seed.sort);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(seed.sortDir);
  const [page, setPage] = useState(seed.page);
  const [pageSize, setPageSize] = useState(seed.pageSize);

  const viewQuery = useMemo<CompanyListQuery>(
    () => ({ q: cleanCompanySearch(debouncedSearch), sort, sortDir, page, pageSize }),
    [debouncedSearch, sort, sortDir, page, pageSize]
  );

  // Reset to page 1 when the search or the sort changes — but not for the
  // seeded view, so a URL-supplied page survives back-navigation. The last key
  // starts at the seed's own key, which is the mount guard (a didMountRef):
  // `useDebounce` returns its initial value immediately, so the first render's
  // key equals it. Done while rendering ("adjust state while rendering")
  // rather than in an effect, so the request for the new search never goes out
  // with the old page number first.
  const resetKey = JSON.stringify([cleanCompanySearch(debouncedSearch), sort, sortDir]);
  const [lastResetKey, setLastResetKey] = useState(() =>
    JSON.stringify([seed.q, seed.sort, seed.sortDir])
  );
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    if (page !== 1) setPage(1);
  }

  // Mirror the view to the URL. The search box's own text is written (not the
  // debounced copy) so the address bar keeps up with typing.
  useEffect(() => {
    const qs = buildCompanyListParams({ ...viewQuery, q: cleanCompanySearch(search) }).toString();
    if (qs !== searchParams.toString()) {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [viewQuery, search, searchParams, pathname, router]);

  const listQs = buildCompanyListParams(viewQuery).toString();
  // `reload` is aliased as fetchCompanies so mutation handlers can refresh the
  // current page; the hook derives `loading` without a setState-in-effect.
  const {
    data: listData,
    loading,
    error: listError,
    reload: fetchCompanies,
  } = useFetchJson<CompanyListResponse>(`/api/admin/companies${listQs ? `?${listQs}` : ""}`);
  const companies = listData?.rows ?? [];
  const total = listData?.total ?? 0;

  // The server clamps a page past the end (a stale link, or a delete that
  // emptied the last page) to the last page; adopt that so the pager and the
  // URL agree with the table. "Adjust state while rendering", not an effect.
  if (listData && !loading && !listError && listData.page !== page) {
    setPage(listData.page);
  }

  // After a mutation, refresh this page AND the shared per-session company
  // list (`/api/companies` via CompanyScopeProvider) — the header switcher and
  // the Users / API Keys company pickers read that list, so without this a
  // created, renamed or deleted company would be stale there until a reload.
  const afterMutation = () => {
    fetchCompanies();
    void companyScope.refresh();
  };

  const handleSort = (key: CompanySortKey) => {
    if (sort === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSort(key);
      // A count reads most usefully largest-first; a name A–Z.
      setSortDir(key === "studentCount" ? "desc" : "asc");
    }
  };

  const sortIndicator = (key: CompanySortKey) =>
    sort === key ? (sortDir === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : null;

  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState("");

  const [editCompany, setEditCompany] = useState<CompanyRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editError, setEditError] = useState("");

  const [deleteCompany, setDeleteCompany] = useState<CompanyRow | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const handleAdd = async () => {
    setAddError("");
    const res = await fetch("/api/admin/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: addName }),
    });
    const data = await res.json();
    if (!res.ok) {
      setAddError(data.error);
      return;
    }
    setShowAdd(false);
    setAddName("");
    afterMutation();
  };

  const handleEdit = async () => {
    if (!editCompany) return;
    setEditError("");
    const res = await fetch(`/api/admin/companies/${editCompany.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName }),
    });
    const data = await res.json();
    if (!res.ok) {
      setEditError(data.error);
      return;
    }
    setEditCompany(null);
    afterMutation();
  };

  const handleDelete = async () => {
    if (!deleteCompany) return;
    setDeleteError("");
    const res = await fetch(`/api/admin/companies/${deleteCompany.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json();
      setDeleteError(data.error);
      return;
    }
    setDeleteCompany(null);
    afterMutation();
  };

  if (!listData && loading) {
    return <LoadingState label="Loading companies…" />;
  }

  const searching = cleanCompanySearch(debouncedSearch) !== "";

  return (
    <div>
      <PageHeader
        title="Companies"
        showBack
        helpSlug="companies"
        rightContent={
          <button
            onClick={() => {
              setAddName("");
              setAddError("");
              setShowAdd(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            <Plus size={16} /> Add Company
          </button>
        }
      />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search companies..."
            className="flex-1 max-w-md"
          />
        </div>

        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className={`w-full text-sm transition-opacity ${loading ? "opacity-60" : ""}`}>
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left font-semibold text-gray-700">
                  <button
                    onClick={() => handleSort("name")}
                    className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900"
                  >
                    Name
                    {sortIndicator("name")}
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">
                  <button
                    onClick={() => handleSort("studentCount")}
                    className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900"
                  >
                    Students
                    {sortIndicator("studentCount")}
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Created</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {companies.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                    {listError
                      ? "Failed to load companies."
                      : searching
                        ? "No companies match your search."
                        : "No companies yet."}
                  </td>
                </tr>
              )}
              {companies.map((c) => (
                <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-700 font-medium flex items-center gap-2">
                    <Building2 size={14} className="text-gray-400" />
                    {c.name}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{c.studentCount}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <button
                        onClick={() => {
                          setEditCompany(c);
                          setEditName(c.name);
                          setEditError("");
                        }}
                        className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                        title="Rename"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => {
                          setDeleteCompany(c);
                          setDeleteError("");
                        }}
                        className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          pageSizeOptions={[...COMPANY_PAGE_SIZES]}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          itemLabel="companies"
        />
      </div>

      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add Company"
        actions={
          <>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleAdd} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Create</button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              autoFocus
            />
          </div>
          {addError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{addError}</div>}
        </div>
      </Modal>

      <Modal
        open={!!editCompany}
        onClose={() => setEditCompany(null)}
        title={`Rename Company: ${editCompany?.name}`}
        actions={
          <>
            <button onClick={() => setEditCompany(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleEdit} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Save</button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              autoFocus
            />
          </div>
          {editError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{editError}</div>}
        </div>
      </Modal>

      <Modal
        open={!!deleteCompany}
        onClose={() => setDeleteCompany(null)}
        title="Delete Company"
        actions={
          <>
            <button onClick={() => setDeleteCompany(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleDelete} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete</button>
          </>
        }
      >
        <p className="text-gray-600">
          Are you sure you want to delete <strong>{deleteCompany?.name}</strong>? This cannot be undone.
        </p>
        {(deleteCompany?.studentCount ?? 0) > 0 && (
          <p className="mt-2 text-sm text-amber-700">
            This company has {deleteCompany?.studentCount} assigned student(s). Reassign them before deleting.
          </p>
        )}
        {deleteError && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{deleteError}</div>
        )}
      </Modal>
    </div>
  );
}

export default function CompaniesPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading companies…" />}>
      <CompaniesPageInner />
    </Suspense>
  );
}
