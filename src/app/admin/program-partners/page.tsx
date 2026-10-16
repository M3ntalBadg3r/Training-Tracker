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
 * Program Partners — each partner's (company's) own terms for a program, per
 * view: for the By Country Set view, its minimum number of countries and the
 * Country Set the view opens on; for the By Theatre view, its minimum number
 * of target countries and the Country Set listing them. Any program may carry
 * partner rows. Company-scoped like /admin/country-sets: the list follows the
 * header company switcher, a company Admin manages their own companies' rows
 * and a SuperAdmin all of them. The company scope is not mirrored to the URL
 * (CompanyScopeProvider persists it); `q`/`sort`/`sortDir` are.
 */

interface FormState {
  id: number | null;
  companyId: number | "";
  companyName: string;
  programId: number | "";
  programName: string;
  countrySetMinimum: string;
  countrySetId: number | "";
  targetMinimum: string;
  targetCountrySetId: number | "";
}

const EMPTY_FORM: FormState = {
  id: null,
  companyId: "",
  companyName: "",
  programId: "",
  programName: "",
  countrySetMinimum: "",
  countrySetId: "",
  targetMinimum: "",
  targetCountrySetId: "",
};

type MinimumSource = "partner" | "default" | "none" | "unused";

/**
 * The minimum that applies in one view: the partner's own, else the program
 * default — or none at all when the program has no requirements at that view's
 * level (`inUse === false`), since nothing would ever enforce it there.
 */
function effectiveMinimum(
  own: number | null,
  fallback: number | null,
  inUse: boolean | undefined
): { value: number | null; source: MinimumSource } {
  if (inUse === false) return { value: null, source: "unused" };
  if (own != null) return { value: own, source: "partner" };
  if (fallback != null) return { value: fallback, source: "default" };
  return { value: null, source: "none" };
}

const csEffective = (r: ProgramCompanySettingRow) =>
  effectiveMinimum(r.countrySetMinimumCountries, r.defaultCountrySetMinimumCountries, r.countrySetInUse);
const targetEffective = (r: ProgramCompanySettingRow) =>
  effectiveMinimum(r.targetMinimumCountries, r.defaultTargetMinimumCountries, r.targetInUse);

function effectiveText(e: { value: number | null; source: MinimumSource }, view: "countrySet" | "theatre"): string {
  if (e.source === "unused") {
    return view === "countrySet"
      ? "Not in use — no Country Set requirements"
      : "Not in use — no Target countries requirements";
  }
  if (e.source === "partner") return `${e.value} (partner)`;
  if (e.source === "default") return `${e.value} (program default)`;
  return "No minimum";
}

const setCount = (n: number) => `${n} ${n === 1 ? "country" : "countries"}`;

// Module-level so the sorter's memo is not invalidated on every render.
const SORT_ACCESSORS: Record<string, SortAccessor<ProgramCompanySettingRow>> = {
  program: (r) => r.programName,
  company: (r) => r.companyName,
  csMinimum: (r) => r.countrySetMinimumCountries,
  countrySet: (r) => r.countrySet ?? "",
  csEffective: (r) => csEffective(r).value,
  targetMinimum: (r) => r.targetMinimumCountries,
  target: (r) => r.targetCountrySet ?? "",
  targetEffective: (r) => targetEffective(r).value,
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
        (r.countrySet ?? "").toLowerCase().includes(q) ||
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
      countrySetMinimum: r.countrySetMinimumCountries != null ? String(r.countrySetMinimumCountries) : "",
      countrySetId: r.countrySetId ?? "",
      targetMinimum: r.targetMinimumCountries != null ? String(r.targetMinimumCountries) : "",
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
        countrySetMinimumCountries: form.countrySetMinimum.trim() === "" ? null : form.countrySetMinimum.trim(),
        countrySetId: form.countrySetId === "" ? null : form.countrySetId,
        targetMinimumCountries: form.targetMinimum.trim() === "" ? null : form.targetMinimum.trim(),
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
    // The import's own columns, so the file round-trips. The two "Effective"
    // columns are read-only context and ignored by the import.
    const out = sorted.map((r) => ({
      program: r.programName,
      company: r.companyName,
      csMinimum: r.countrySetMinimumCountries ?? "",
      countrySet: r.countrySet ?? "",
      targetMinimum: r.targetMinimumCountries ?? "",
      target: r.targetCountrySet ?? "",
      csEffective: effectiveText(csEffective(r), "countrySet"),
      targetEffective: effectiveText(targetEffective(r), "theatre"),
    }));
    const columns: { key: keyof (typeof out)[number]; header: string }[] = [
      { key: "program", header: "Program" },
      { key: "company", header: "Company" },
      { key: "csMinimum", header: "Country Set Minimum" },
      { key: "countrySet", header: "Country Set" },
      { key: "targetMinimum", header: "Target Minimum" },
      { key: "target", header: "Target Country Set" },
      { key: "csEffective", header: "Effective Country Set Minimum" },
      { key: "targetEffective", header: "Effective Target Minimum" },
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
        description="Each partner's own terms for a program: its minimum and Country Set for the By Country Set view, and its minimum and target Country Set for the By Theatre view."
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
        A partner with no minimum of its own uses the program&apos;s default. In the By Country Set view the minimum
        is compared with the number of countries in the set; in the By Theatre view, with the number of the
        partner&apos;s target countries inside the theatre being viewed (only for programs with Target countries
        requirements).
      </p>

      {noPrograms && (
        <div className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
          There are no programs yet. A SuperAdmin creates programs in Admin › Program Data.
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
            <tr className="bg-gray-50 border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
              <th colSpan={2} />
              <th colSpan={3} className="px-4 pt-2 text-left font-semibold border-l border-gray-200">
                By Country Set view
              </th>
              <th colSpan={3} className="px-4 pt-2 text-left font-semibold border-l border-gray-200">
                By Theatre view
              </th>
              <th />
            </tr>
            <tr className="bg-gray-50 border-b border-gray-200">
              {th("program", "Program")}
              {th("company", "Company")}
              {th("csMinimum", "Minimum countries")}
              {th("countrySet", "Country Set")}
              {th("csEffective", "Effective minimum")}
              {th("targetMinimum", "Minimum target countries")}
              {th("target", "Target Country Set")}
              {th("targetEffective", "Effective minimum")}
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
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
                <td className="px-4 py-3 text-gray-700 border-l border-gray-100">
                  {r.countrySetMinimumCountries ?? <span className="text-gray-400">—</span>}
                </td>
                <td className="px-4 py-3 text-gray-700">
                  {r.countrySet ?? <span className="text-gray-400">Not set</span>}
                </td>
                <td className="px-4 py-3 text-gray-700">{effectiveText(csEffective(r), "countrySet")}</td>
                <td className="px-4 py-3 text-gray-700 border-l border-gray-100">
                  {r.targetMinimumCountries ?? <span className="text-gray-400">—</span>}
                </td>
                <td className="px-4 py-3 text-gray-700">
                  {r.targetCountrySet ?? <span className="text-gray-400">Not set</span>}
                </td>
                <td className="px-4 py-3 text-gray-700">{effectiveText(targetEffective(r), "theatre")}</td>
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
                  setForm((f) => ({
                    ...f,
                    companyId: typeof next === "number" ? next : "",
                    countrySetId: "",
                    targetCountrySetId: "",
                  }))
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
                <option value="">-- Select a program --</option>
                {programs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <div id="partner-program" className="text-sm text-gray-800">
                {form.programName}
              </div>
            )}
          </div>
          <fieldset className="space-y-3 border-t border-gray-200 pt-3">
            <legend className="text-sm font-semibold text-gray-800">By Country Set view</legend>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="partner-cs-minimum">
                Minimum countries <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <input
                id="partner-cs-minimum"
                type="number"
                min={1}
                max={1000}
                step={1}
                value={form.countrySetMinimum}
                onChange={(e) => setForm((f) => ({ ...f, countrySetMinimum: e.target.value }))}
                placeholder={
                  selectedProgram?.countrySetMinimumCountries != null
                    ? `Program default: ${selectedProgram.countrySetMinimumCountries}`
                    : "No minimum"
                }
                className={`${INPUT_CLASS} w-full`}
              />
              <p className="mt-1 text-xs text-gray-500">
                Leave blank to use the program&apos;s default. A Country Set with fewer countries reaches no tier.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="partner-cs-set">
                Country Set <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <select
                id="partner-cs-set"
                value={form.countrySetId}
                onChange={(e) => setForm((f) => ({ ...f, countrySetId: e.target.value ? Number(e.target.value) : "" }))}
                disabled={form.companyId === "" || setsLoading}
                className={`${SELECT_CLASS} w-full disabled:opacity-50`}
              >
                <option value="">
                  {form.companyId === "" ? "Pick a company first" : setsLoading ? "Loading sets…" : "Not set"}
                </option>
                {companySets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({setCount(s.countries.length)})
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                The company&apos;s own set the By Country Set view opens on.
              </p>
            </div>
          </fieldset>
          <fieldset className="space-y-3 border-t border-gray-200 pt-3">
            <legend className="text-sm font-semibold text-gray-800">By Theatre view</legend>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="partner-target-minimum">
                Minimum target countries <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <input
                id="partner-target-minimum"
                type="number"
                min={1}
                max={1000}
                step={1}
                value={form.targetMinimum}
                onChange={(e) => setForm((f) => ({ ...f, targetMinimum: e.target.value }))}
                placeholder={
                  selectedProgram?.targetMinimumCountries != null
                    ? `Program default: ${selectedProgram.targetMinimumCountries}`
                    : "No minimum"
                }
                className={`${INPUT_CLASS} w-full`}
              />
              <p className="mt-1 text-xs text-gray-500">
                Leave blank to use the program&apos;s default. With fewer target countries inside the viewed theatre,
                no tier is reached. Applies only to programs with Target countries requirements.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="partner-target-set">
                Target Country Set <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <select
                id="partner-target-set"
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
                    {s.name} ({setCount(s.countries.length)})
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                The company&apos;s own set listing its target countries. In the By Theatre view, only those inside the
                theatre being viewed count.
              </p>
            </div>
          </fieldset>
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
          <strong>{deleteTarget?.programName}</strong>? The partner will then use the program&apos;s default minimums
          and have no Country Set or target Country Set chosen.
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
