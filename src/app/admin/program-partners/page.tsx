"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Pencil, Plus, Trash2, Upload } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import SearchInput, { INPUT_CLASS, SELECT_CLASS } from "@/components/ui/FormControls";
import LoadingState from "@/components/ui/LoadingState";
import ExportMenu, { type ExportFormat } from "@/components/ui/ExportMenu";
import CompanyPicker from "@/components/company/CompanyPicker";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useTableSort, type SortAccessor } from "@/hooks/useTableSort";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import type { CountrySetListResponse } from "@/app/api/admin/country-sets/route";
import type {
  ProgramCompanySettingRow,
  ProgramCompanySettingsResponse,
} from "@/app/api/admin/program-company-settings/route";
import ImportProgramPartnersModal from "./ImportModal";

/**
 * Program Partners — each partner's (company's) own terms for an anchored
 * program: the minimum number of target countries it must name and which of
 * its Country Sets holds them. Company-scoped like /admin/country-sets: the
 * list follows the header company switcher, a company Admin manages their own
 * companies' rows and a SuperAdmin all of them. The company scope is not
 * mirrored to the URL (CompanyScopeProvider persists it); `q`/`sort`/`sortDir`
 * are.
 */

interface FormState {
  id: number | null;
  companyId: number | "";
  companyName: string;
  programId: number | "";
  programName: string;
  minimum: string;
  targetCountrySetId: number | "";
}

const EMPTY_FORM: FormState = {
  id: null,
  companyId: "",
  companyName: "",
  programId: "",
  programName: "",
  minimum: "",
  targetCountrySetId: "",
};

/** The minimum that applies to a row: the partner's own, else the program default. */
function effectiveMinimum(r: ProgramCompanySettingRow): { value: number | null; source: "partner" | "default" | "none" } {
  if (r.minimumCountries != null) return { value: r.minimumCountries, source: "partner" };
  if (r.defaultMinimumCountries != null) return { value: r.defaultMinimumCountries, source: "default" };
  return { value: null, source: "none" };
}

/**
 * What a row means now. A row survives its program being un-anchored (it
 * comes back into force if the program is anchored again), but while the
 * program is not anchored nothing reads it — so it must not claim a minimum.
 */
const NOT_IN_USE = "Not in use — program not anchored";

function effectiveText(r: ProgramCompanySettingRow, anchoredIds: Set<number>): string {
  if (!anchoredIds.has(r.programId)) return NOT_IN_USE;
  const e = effectiveMinimum(r);
  if (e.source === "partner") return String(e.value);
  if (e.source === "default") return `${e.value} (program default)`;
  return "No minimum";
}

// Module-level so the sorter's memo is not invalidated on every render.
const SORT_ACCESSORS: Record<string, SortAccessor<ProgramCompanySettingRow>> = {
  program: (r) => r.programName,
  company: (r) => r.companyName,
  minimum: (r) => r.minimumCountries,
  target: (r) => r.targetCountrySet ?? "",
  effective: (r) => effectiveMinimum(r).value,
};
const DEFAULT_SORT_KEY = "program";

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return typeof data?.error === "string" ? data.error : fallback;
  } catch {
    return fallback;
  }
}

function ProgramPartnersInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const companyScope = useCompanyScope();
  const { selected: selectedCompany, setSelected: setSelectedCompany, companies } = companyScope;
  const { data, loading, error, reload } = useFetchJson<ProgramCompanySettingsResponse>(
    withCompany("/api/admin/program-company-settings", selectedCompany),
    { enabled: !companyScope.loading }
  );
  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data]);
  const programs = useMemo(() => (Array.isArray(data?.programs) ? data.programs : []), [data]);
  // The GET lists only anchored programs; a row naming any other is dormant.
  const anchoredIds = useMemo(() => new Set(programs.map((p) => p.id)), [programs]);

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
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.programName.toLowerCase().includes(q) ||
        r.companyName.toLowerCase().includes(q) ||
        (r.targetCountrySet ?? "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  const { sorted, sortKey, sortDir, toggleSort, sortIndicator } = useTableSort(filtered, SORT_ACCESSORS, {
    defaultKey: urlSort.key,
    defaultDir: urlSort.dir,
    tiebreakKey: "company",
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
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProgramCompanySettingRow | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  // The chosen company's own Country Sets — the only sets a row may name.
  const setsUrl =
    formOpen && typeof form.companyId === "number"
      ? `/api/admin/country-sets?companyId=${form.companyId}`
      : null;
  const { data: setsData, loading: setsLoading } = useFetchJson<CountrySetListResponse>(setsUrl);
  const companySets = useMemo(
    () =>
      typeof form.companyId === "number" && Array.isArray(setsData?.sets)
        ? setsData.sets.filter((s) => s.companyId === form.companyId)
        : [],
    [setsData, form.companyId]
  );

  // See /admin/country-sets: point the header switcher at a company the view
  // would otherwise hide, so a new row does not land out of sight.
  const focusCompany = useCallback(
    (companyId: number): boolean => {
      if (selectedCompany === "all" || selectedCompany === companyId) return false;
      setSelectedCompany(companyId);
      return true;
    },
    [selectedCompany, setSelectedCompany]
  );

  const defaultCompany: number | "" =
    selectedCompany !== "all" ? selectedCompany : companies.length === 1 ? companies[0].id : "";

  const openAdd = () => {
    setForm({ ...EMPTY_FORM, companyId: defaultCompany, programId: programs.length === 1 ? programs[0].id : "" });
    setFormError("");
    setFormOpen(true);
  };

  const openEdit = (r: ProgramCompanySettingRow) => {
    setForm({
      id: r.id,
      companyId: r.companyId,
      companyName: r.companyName,
      programId: r.programId,
      programName: r.programName,
      minimum: r.minimumCountries != null ? String(r.minimumCountries) : "",
      targetCountrySetId: r.targetCountrySetId ?? "",
    });
    setFormError("");
    setFormOpen(true);
  };

  const selectedProgram = programs.find((p) => p.id === form.programId);

  const handleSave = async () => {
    setFormError("");
    const isCreate = form.id === null;
    if (isCreate && form.companyId === "") {
      setFormError("Please pick a company");
      return;
    }
    if (isCreate && form.programId === "") {
      setFormError("Please pick a program");
      return;
    }
    const companyId = form.companyId;
    setSaving(true);
    try {
      const payload = {
        ...(isCreate ? { companyId: form.companyId, programId: form.programId } : {}),
        minimumCountries: form.minimum.trim() === "" ? null : form.minimum.trim(),
        targetCountrySetId: form.targetCountrySetId === "" ? null : form.targetCountrySetId,
      };
      const res = await fetch(
        isCreate ? "/api/admin/program-company-settings" : `/api/admin/program-company-settings/${form.id}`,
        { method: isCreate ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
      );
      if (!res.ok) {
        setFormError(await readError(res, "Could not save the partner settings"));
        return;
      }
      setFormOpen(false);
      const switched = isCreate && typeof companyId === "number" && focusCompany(companyId);
      if (!switched) reload();
    } catch {
      setFormError("Could not save the partner settings");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError("");
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/program-company-settings/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        setDeleteError(await readError(res, "Could not delete the partner settings"));
        return;
      }
      setDeleteTarget(null);
      reload();
    } catch {
      setDeleteError("Could not delete the partner settings");
    } finally {
      setDeleting(false);
    }
  };

  const handleExport = (fmt: ExportFormat) => {
    // The import's own columns, so the file round-trips. "Effective Minimum"
    // is read-only context and ignored by the import.
    const out = sorted.map((r) => ({
      program: r.programName,
      company: r.companyName,
      minimum: r.minimumCountries ?? "",
      target: r.targetCountrySet ?? "",
      effective: effectiveText(r, anchoredIds),
    }));
    const columns: { key: keyof (typeof out)[number]; header: string }[] = [
      { key: "program", header: "Program" },
      { key: "company", header: "Company" },
      { key: "minimum", header: "Minimum Target Countries" },
      { key: "target", header: "Target Country Set" },
      { key: "effective", header: "Effective Minimum" },
    ];
    if (fmt === "csv") exportToCsv(out, columns, "program-partners");
    else if (fmt === "excel") exportToExcel(out, columns, "program-partners");
    else exportToPdf(out, columns, "program-partners");
  };

  if (loading) return <LoadingState label="Loading program partners…" />;

  const noCompanies = !companyScope.loading && companies.length === 0;
  const noPrograms = programs.length === 0;

  const th = (key: string, label: string) => (
    <th
      className="px-4 py-3 text-left font-semibold text-gray-700 cursor-pointer select-none"
      onClick={() => toggleSort(key)}
    >
      {label}
      {sortIndicator(key)}
    </th>
  );

  return (
    <div>
      <PageHeader
        title="Program Partners"
        description="Each partner's own terms for an anchored program: its minimum number of target countries and the Country Set that holds them."
        showBack
        helpSlug="program-partners"
      />

      <section className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search programs, companies, sets…" />
        <Button variant="secondary" onClick={() => setImportOpen(true)} disabled={noCompanies || noPrograms}>
          <Upload size={16} /> Import
        </Button>
        <ExportMenu onExport={(fmt) => handleExport(fmt)} label="Export" />
        <Button onClick={openAdd} disabled={noCompanies || noPrograms}>
          <Plus size={16} /> Add Partner Settings
        </Button>
      </section>

      <p className="mb-4 text-sm text-gray-600">
        A partner with no minimum of its own uses the program&apos;s default. Only countries inside the program&apos;s
        anchor theatre count toward the minimum.
      </p>

      {noPrograms && (
        <div className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
          No program is anchored yet. A SuperAdmin anchors a program to a theatre in Admin › Program Data.
        </div>
      )}
      {noCompanies && (
        <div className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
          You do not have access to any companies, so there is nowhere to add partner settings.
        </div>
      )}
      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
          Could not load program partners.
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {th("program", "Program")}
              {th("company", "Company")}
              {th("minimum", "Minimum target countries")}
              {th("target", "Target Country Set")}
              {th("effective", "Effective minimum")}
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  {rows.length === 0 ? "No partner settings yet." : "No partner settings match your search."}
                </td>
              </tr>
            )}
            {sorted.map((r) => (
              <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-700 font-medium">{r.programName}</td>
                <td className="px-4 py-3">
                  <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded">{r.companyName}</span>
                </td>
                <td className="px-4 py-3 text-gray-700">{r.minimumCountries ?? <span className="text-gray-400">—</span>}</td>
                <td className="px-4 py-3 text-gray-700">
                  {r.targetCountrySet ?? <span className="text-gray-400">Not set</span>}
                </td>
                <td className={`px-4 py-3 ${anchoredIds.has(r.programId) ? "text-gray-700" : "text-amber-700"}`}>
                  {effectiveText(r, anchoredIds)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <button
                      onClick={() => openEdit(r)}
                      className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                      title="Edit"
                      aria-label={`Edit ${r.programName} for ${r.companyName}`}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setDeleteTarget(r);
                        setDeleteError("");
                      }}
                      className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                      title="Delete"
                      aria-label={`Delete ${r.programName} for ${r.companyName}`}
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
        title={form.id === null ? "Add Partner Settings" : "Edit Partner Settings"}
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
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="partner-company">
              Company
            </label>
            {form.id === null ? (
              <CompanyPicker
                id="partner-company"
                options={companies}
                value={form.companyId === "" ? null : form.companyId}
                onChange={(next) =>
                  setForm((f) => ({ ...f, companyId: typeof next === "number" ? next : "", targetCountrySetId: "" }))
                }
                clearable
                placeholder="-- Select a company --"
              />
            ) : (
              <div id="partner-company" className="text-sm text-gray-800">
                {form.companyName}
              </div>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="partner-program">
              Program
            </label>
            {form.id === null ? (
              <select
                id="partner-program"
                value={form.programId}
                onChange={(e) => setForm((f) => ({ ...f, programId: e.target.value ? Number(e.target.value) : "" }))}
                className={`${SELECT_CLASS} w-full`}
              >
                <option value="">-- Select an anchored program --</option>
                {programs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.anchorTheatre})
                  </option>
                ))}
              </select>
            ) : (
              <div id="partner-program" className="text-sm text-gray-800">
                {form.programName}
              </div>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="partner-minimum">
              Minimum target countries <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              id="partner-minimum"
              type="number"
              min={1}
              max={1000}
              step={1}
              value={form.minimum}
              onChange={(e) => setForm((f) => ({ ...f, minimum: e.target.value }))}
              placeholder={
                selectedProgram?.defaultMinimumCountries != null
                  ? `Program default: ${selectedProgram.defaultMinimumCountries}`
                  : "No minimum"
              }
              className={`${INPUT_CLASS} w-full`}
            />
            <p className="mt-1 text-xs text-gray-500">
              Leave blank to use the program&apos;s default. Below this number of target countries, no tier is reached.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="partner-set">
              Target Country Set <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <select
              id="partner-set"
              value={form.targetCountrySetId}
              onChange={(e) =>
                setForm((f) => ({ ...f, targetCountrySetId: e.target.value ? Number(e.target.value) : "" }))
              }
              disabled={form.companyId === "" || setsLoading}
              className={`${SELECT_CLASS} w-full disabled:opacity-50`}
            >
              <option value="">
                {form.companyId === "" ? "Pick a company first" : setsLoading ? "Loading sets…" : "Not set"}
              </option>
              {companySets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.countries.length} {s.countries.length === 1 ? "country" : "countries"})
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              The company&apos;s own set listing its target countries. The program dashboard opens on it.
            </p>
          </div>
          {formError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{formError}</div>
          )}
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete Partner Settings"
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
          Delete the settings for <strong>{deleteTarget?.companyName}</strong> on{" "}
          <strong>{deleteTarget?.programName}</strong>? The partner will then use the program&apos;s default minimum
          and have no target Country Set chosen.
        </p>
        {deleteError && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{deleteError}</div>
        )}
      </Modal>

      {importOpen && (
        <ImportProgramPartnersModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={(companyIds) => {
            const switched = companyIds.length === 1 && focusCompany(companyIds[0]);
            if (!switched) reload();
          }}
          companies={companies}
          defaultCompanyId={defaultCompany}
        />
      )}
    </div>
  );
}

export default function ProgramPartnersPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading program partners…" />}>
      <ProgramPartnersInner />
    </Suspense>
  );
}
