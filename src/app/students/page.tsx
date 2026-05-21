"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import DataTable, { type DataTableState } from "@/components/data-table/DataTable";
import Modal from "@/components/ui/Modal";
import { ColumnDef, CountryOption, StudentRow } from "@/types";
import { useAuth } from "@/components/auth/AuthProvider";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { Plus } from "lucide-react";

interface CompanyOption { id: number; name: string }

function StudentsPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAdmin } = useAuth();
  const companyScope = useCompanyScope();

  // Table state is mirrored to the URL so it survives navigating into a
  // student record and pressing Back.
  const initialSearchTerm = searchParams.get("q") ?? "";
  const initialSearchColumn = searchParams.get("qCol") ?? "all";
  const initialSortColumn = searchParams.get("sort") ?? undefined;
  const initialSortDirRaw = searchParams.get("sortDir");
  const initialSortDirection: "asc" | "desc" | undefined =
    initialSortDirRaw === "asc" || initialSortDirRaw === "desc"
      ? initialSortDirRaw
      : undefined;
  const initialColumnFilters = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      if (key.startsWith("f_") && value) out[key.slice(2)] = value;
    });
    return out;
  }, [searchParams]);

  const handleTableStateChange = useCallback(
    (state: DataTableState) => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("q");
      params.delete("qCol");
      params.delete("sort");
      params.delete("sortDir");
      for (const key of Array.from(params.keys())) {
        if (key.startsWith("f_")) params.delete(key);
      }
      if (state.searchTerm) params.set("q", state.searchTerm);
      if (state.searchColumn && state.searchColumn !== "all")
        params.set("qCol", state.searchColumn);
      if (state.sortColumn) {
        params.set("sort", state.sortColumn);
        params.set("sortDir", state.sortDirection);
      }
      for (const [key, value] of Object.entries(state.columnFilters)) {
        if (value) params.set(`f_${key}`, value);
      }
      const qs = params.toString();
      if (qs !== searchParams.toString()) {
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      }
    },
    [searchParams, pathname, router]
  );
  const [students, setStudents] = useState<(StudentRow & { companyName?: string | null })[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [countries, setCountries] = useState<CountryOption[]>([]);

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

  // The "Company" column is only visible when the global switcher is set to "All"
  // (otherwise every row has the same company value, which adds visual noise).
  const showCompanyColumn = companyScope.selected === "all";

  const columns: ColumnDef<StudentRow & { companyName?: string | null }>[] = [
    { key: "fullName", header: "Full Name" },
    { key: "email", header: "Email Address" },
    ...(showCompanyColumn
      ? [{ key: "companyName" as const, header: "Company", accessor: (row: StudentRow & { companyName?: string | null }) => row.companyName ?? "" }]
      : []),
    { key: "theatre", header: "Theatre" },
    {
      key: "region",
      header: "Region",
      accessor: (row) => {
        const r = (row.region ?? "").trim();
        if (!r) return "N/A";
        const lower = r.toLowerCase();
        if (lower === "unknown" || lower === "not applicable") return "";
        return r;
      },
    },
    { key: "country", header: "Country" },
  ];

  const fetchStudents = () =>
    fetch(withCompany("/api/students", companyScope.selected))
      .then((res) => res.json())
      .then((data) => setStudents(data));

  useEffect(() => {
    if (companyScope.loading) return;
    setLoading(true);
    fetchStudents().finally(() => setLoading(false));
    fetch("/api/import-metadata?key=students")
      .then((res) => res.json())
      .then((data) => {
        if (data?.timestamp) setLastImport(data.timestamp);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyScope.loading, companyScope.selected]);

  useEffect(() => {
    fetch("/api/region-data/countries")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: CountryOption[]) => setCountries(Array.isArray(data) ? data : []))
      .catch(() => setCountries([]));
  }, []);

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
      await fetchStudents();
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading students...</div>
      </div>
    );
  }

  // Default the picker to the currently-selected company (when not "all"),
  // so adding a student in a single-company view is one click.
  const defaultCompanyForAdd = (): number | "" => {
    if (companyScope.selected !== "all") return companyScope.selected;
    if (companyScope.companies.length === 1) return companyScope.companies[0].id;
    return "";
  };

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
      <DataTable<StudentRow & { companyName?: string | null }>
        data={students}
        columns={columns}
        defaultSortColumn="fullName"
        initialSearchTerm={initialSearchTerm}
        initialSearchColumn={initialSearchColumn}
        initialColumnFilters={initialColumnFilters}
        initialSortColumn={initialSortColumn}
        initialSortDirection={initialSortDirection}
        onStateChange={handleTableStateChange}
        rowAction={{
          label: "View",
          onClick: (row) => router.push(`/students/${encodeURIComponent(row.email)}`),
        }}
      />

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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Theatre</label>
              <div className="w-full px-3 py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-700 min-h-[38px]">
                {selectedCountry?.theatre ?? <span className="text-gray-400">—</span>}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Region</label>
              <div className="w-full px-3 py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-700 min-h-[38px]">
                {selectedCountry?.region ?? <span className="text-gray-400">—</span>}
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
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading students...</div>
        </div>
      }
    >
      <StudentsPageInner />
    </Suspense>
  );
}
