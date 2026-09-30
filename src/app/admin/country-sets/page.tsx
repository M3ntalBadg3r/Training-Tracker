"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { MapPinned, Pencil, Plus, Trash2 } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import SearchInput, { INPUT_CLASS, SELECT_CLASS } from "@/components/ui/FormControls";
import LoadingState from "@/components/ui/LoadingState";
import ExportMenu, { type ExportFormat } from "@/components/ui/ExportMenu";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useRegionData, type RegionDataRow } from "@/hooks/useRegionData";
import { useTableSort, type SortAccessor } from "@/hooks/useTableSort";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import type { CountrySetRow } from "@/types";
import type { CountrySetListResponse } from "@/app/api/admin/country-sets/route";

interface FormState {
  id: number | null;
  name: string;
  description: string;
  countries: string[];
}

const EMPTY_FORM: FormState = { id: null, name: "", description: "", countries: [] };

// Module-level so the sorter's memo is not invalidated on every render.
const SORT_ACCESSORS: Record<string, SortAccessor<CountrySetRow>> = {
  name: (s) => s.name,
  description: (s) => s.description ?? "",
  countries: (s) => s.countries.length,
};

const DEFAULT_SORT_KEY = "name";
const PREVIEW_COUNT = 3;

function countriesPreview(countries: string[]): string {
  if (countries.length === 0) return "0";
  const shown = countries.slice(0, PREVIEW_COUNT).join(", ");
  return `${countries.length} — ${shown}${countries.length > PREVIEW_COUNT ? ", …" : ""}`;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return typeof data?.error === "string" ? data.error : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Searchable country multiselect over the Region Data list, with bulk helpers
 * to add every country in a region or theatre.
 */
function CountryMultiSelect({
  rows,
  value,
  onChange,
}: {
  rows: RegionDataRow[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [region, setRegion] = useState("");
  const [theatre, setTheatre] = useState("");

  const selected = useMemo(() => new Set(value), [value]);

  const regions = useMemo(
    () => [...new Set(rows.map((r) => r.region).filter((r) => r && r.trim()))].sort((a, b) => a.localeCompare(b)),
    [rows]
  );
  const theatres = useMemo(
    () =>
      [...new Set(rows.map((r) => r.theatre).filter((t): t is string => !!t && !!t.trim()))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [rows]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (selectedOnly && !selected.has(r.country)) return false;
      if (!q) return true;
      return (
        r.country.toLowerCase().includes(q) ||
        r.region.toLowerCase().includes(q) ||
        (r.theatre ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, selectedOnly, selected]);

  const setSorted = (next: Iterable<string>) => onChange([...new Set(next)].sort((a, b) => a.localeCompare(b)));

  const toggle = (country: string) => {
    const next = new Set(selected);
    if (next.has(country)) next.delete(country);
    else next.add(country);
    setSorted(next);
  };

  const addWhere = (pred: (r: RegionDataRow) => boolean) =>
    setSorted([...value, ...rows.filter(pred).map((r) => r.country)]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select value={region} onChange={(e) => setRegion(e.target.value)} className={SELECT_CLASS} aria-label="Region">
          <option value="">Region…</option>
          {regions.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="sm"
          disabled={!region}
          onClick={() => addWhere((r) => r.region === region)}
        >
          Select all in region
        </Button>
        <select value={theatre} onChange={(e) => setTheatre(e.target.value)} className={SELECT_CLASS} aria-label="Theatre">
          <option value="">Theatre…</option>
          {theatres.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="sm"
          disabled={!theatre}
          onClick={() => addWhere((r) => r.theatre === theatre)}
        >
          Select all in theatre
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search countries…" />
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
          <input type="checkbox" checked={selectedOnly} onChange={(e) => setSelectedOnly(e.target.checked)} />
          Selected only
        </label>
        <Button variant="ghost" size="sm" disabled={value.length === 0} onClick={() => onChange([])}>
          Clear
        </Button>
      </div>

      <div className="border border-gray-200 rounded-lg max-h-64 overflow-y-auto divide-y divide-gray-100">
        {rows.length === 0 && (
          <div className="px-3 py-4 text-sm text-gray-500">No countries in Region Data yet.</div>
        )}
        {rows.length > 0 && visible.length === 0 && (
          <div className="px-3 py-4 text-sm text-gray-500">No countries match.</div>
        )}
        {visible.map((r) => {
          const meta = [r.region, r.theatre].filter((v) => v && v.trim()).join(" · ");
          return (
            <label
              key={r.country}
              className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50"
            >
              <input type="checkbox" checked={selected.has(r.country)} onChange={() => toggle(r.country)} />
              <span className="text-gray-800">{r.country}</span>
              {meta && <span className="text-xs text-gray-400">{meta}</span>}
            </label>
          );
        })}
      </div>
      <div className="text-xs text-gray-500">{value.length} selected</div>
    </div>
  );
}

function CountrySetsInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { data, loading, error, reload } = useFetchJson<CountrySetListResponse>("/api/admin/country-sets");
  const sets = useMemo(() => (Array.isArray(data?.sets) ? data.sets : []), [data]);
  const usage = data?.programsUsingCountrySetLevel ?? 0;

  // View state seeded from the URL (re-validated — it is user-editable text).
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [urlSort] = useState(() => {
    const key = searchParams.get("sort") ?? "";
    const dir = searchParams.get("sortDir") === "desc" ? ("desc" as const) : ("asc" as const);
    // `Object.hasOwn`, not `in`: `?sort=constructor` satisfies `in` via the prototype.
    return { key: Object.hasOwn(SORT_ACCESSORS, key) ? key : DEFAULT_SORT_KEY, dir };
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sets;
    return sets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        s.countries.some((c) => c.toLowerCase().includes(q))
    );
  }, [sets, search]);

  const { sorted, sortKey, sortDir, toggleSort, sortIndicator } = useTableSort(filtered, SORT_ACCESSORS, {
    defaultKey: urlSort.key,
    defaultDir: urlSort.dir,
    tiebreakKey: "name",
    descFirstKeys: ["countries"],
  });

  const buildViewParams = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (sortKey !== DEFAULT_SORT_KEY || sortDir !== "asc") {
      params.set("sort", sortKey);
      params.set("sortDir", sortDir);
    }
    return params;
  }, [search, sortKey, sortDir]);

  useEffect(() => {
    const qs = buildViewParams().toString();
    if (qs !== searchParams.toString()) {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [buildViewParams, pathname, router, searchParams]);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const { rows: regionRows, loading: regionLoading } = useRegionData(formOpen);

  const [deleteTarget, setDeleteTarget] = useState<CountrySetRow | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setFormError("");
    setFormOpen(true);
  };

  const openEdit = (s: CountrySetRow) => {
    setForm({ id: s.id, name: s.name, description: s.description ?? "", countries: [...s.countries] });
    setFormError("");
    setFormOpen(true);
  };

  const handleSave = async () => {
    setFormError("");
    if (!form.name.trim()) {
      setFormError("Name is required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(form.id === null ? "/api/admin/country-sets" : `/api/admin/country-sets/${form.id}`, {
        method: form.id === null ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          description: form.description,
          countries: form.countries,
        }),
      });
      if (!res.ok) {
        setFormError(await readError(res, "Could not save the country set"));
        return;
      }
      setFormOpen(false);
      reload();
    } catch {
      setFormError("Could not save the country set");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError("");
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/country-sets/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        setDeleteError(await readError(res, "Could not delete the country set"));
        return;
      }
      setDeleteTarget(null);
      reload();
    } catch {
      setDeleteError("Could not delete the country set");
    } finally {
      setDeleting(false);
    }
  };

  const handleExport = (fmt: ExportFormat) => {
    const rows = sorted.map((s) => ({
      name: s.name,
      description: s.description ?? "",
      countries: s.countries.join(", "),
    }));
    const columns: { key: keyof (typeof rows)[number]; header: string }[] = [
      { key: "name", header: "Name" },
      { key: "description", header: "Description" },
      { key: "countries", header: "Countries" },
    ];
    if (fmt === "csv") exportToCsv(rows, columns, "country-sets");
    else if (fmt === "excel") exportToExcel(rows, columns, "country-sets");
    else exportToPdf(rows, columns, "country-sets");
  };

  if (loading) return <LoadingState label="Loading country sets…" />;

  return (
    <div>
      <PageHeader
        title="Country Sets"
        description="Custom groupings of countries that partner programs can report against."
        showBack
        helpSlug="country-sets"
        rightContent={<ExportMenu onExport={(fmt) => handleExport(fmt)} />}
      />

      <section className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search country sets…" />
        <Button onClick={openAdd}>
          <Plus size={16} /> Add Country Set
        </Button>
      </section>

      {usage > 0 && (
        <p className="mb-4 text-sm text-gray-600">
          {usage === 1 ? "1 program has" : `${usage} programs have`} Country Set requirements. Those apply to whichever set is being viewed, so every set here can be reported against.
        </p>
      )}

      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
          Could not load country sets.
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th
                className="px-4 py-3 text-left font-semibold text-gray-700 cursor-pointer select-none"
                onClick={() => toggleSort("name")}
              >
                Name{sortIndicator("name")}
              </th>
              <th
                className="px-4 py-3 text-left font-semibold text-gray-700 cursor-pointer select-none"
                onClick={() => toggleSort("description")}
              >
                Description{sortIndicator("description")}
              </th>
              <th
                className="px-4 py-3 text-left font-semibold text-gray-700 cursor-pointer select-none"
                onClick={() => toggleSort("countries")}
              >
                Countries{sortIndicator("countries")}
              </th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                  {sets.length === 0 ? "No country sets yet." : "No country sets match your search."}
                </td>
              </tr>
            )}
            {sorted.map((s) => (
              <tr key={s.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-700 font-medium">
                  <span className="inline-flex items-center gap-2">
                    <MapPinned size={14} className="text-gray-400" />
                    {s.name}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600">{s.description ?? ""}</td>
                <td className="px-4 py-3 text-gray-700" title={s.countries.join(", ")}>
                  {countriesPreview(s.countries)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <button
                      onClick={() => openEdit(s)}
                      className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                      title="Edit"
                      aria-label={`Edit ${s.name}`}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setDeleteTarget(s);
                        setDeleteError("");
                      }}
                      className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                      title="Delete"
                      aria-label={`Delete ${s.name}`}
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

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={form.id === null ? "Add Country Set" : "Edit Country Set"}
        size="2xl"
        actions={
          <>
            <Button variant="secondary" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {form.id === null ? "Create" : "Save"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="country-set-name">
              Name
            </label>
            <input
              id="country-set-name"
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className={`${INPUT_CLASS} w-full`}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="country-set-description">
              Description <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <textarea
              id="country-set-description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className={`${INPUT_CLASS} w-full`}
              rows={2}
            />
          </div>
          <div>
            <div className="block text-sm font-medium text-gray-700 mb-1">Countries</div>
            {regionLoading ? (
              <LoadingState label="Loading countries…" size="section" />
            ) : (
              <CountryMultiSelect
                rows={regionRows}
                value={form.countries}
                onChange={(countries) => setForm((f) => ({ ...f, countries }))}
              />
            )}
          </div>
          {formError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{formError}</div>
          )}
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete Country Set"
        actions={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} disabled={deleting}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-gray-600">
          Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This cannot be undone.
        </p>
        {usage > 0 && (
          <p className="mt-2 text-sm text-amber-700">
            Programs with Country Set requirements will no longer be able to report against this set.
          </p>
        )}
        {deleteError && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{deleteError}</div>
        )}
      </Modal>
    </div>
  );
}

export default function CountrySetsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading country sets…" />}>
      <CountrySetsInner />
    </Suspense>
  );
}
