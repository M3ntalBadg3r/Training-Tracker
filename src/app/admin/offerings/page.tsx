"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { OfferingSummaryRow, OfferingDataRow, SpecialisationRow } from "@/types";
import {
  Plus,
  Trash2,
  Save,
  Download,
  Upload,
  FileDown,
  AlertCircle,
  CheckCircle2,
  Package,
  Pencil,
} from "lucide-react";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import Papa from "papaparse";
import * as XLSX from "xlsx";

interface ExportRow {
  offeringName: string;
  companyName: string;
  description: string;
  link: string;
  specialisationName: string;
  trainingType: string;
  trainingFullTitle: string;
  quantityRequired: number | string;
  alternatives: string;
}

const exportColumns: { key: keyof ExportRow; header: string }[] = [
  { key: "offeringName", header: "Offering Name" },
  { key: "companyName", header: "Company" },
  { key: "description", header: "Description" },
  { key: "link", header: "Link" },
  { key: "specialisationName", header: "Specialisation" },
  { key: "trainingType", header: "Training Type" },
  { key: "trainingFullTitle", header: "Training" },
  { key: "quantityRequired", header: "Quantity Required" },
  { key: "alternatives", header: "Alternatives" },
];

// Import column aliases → ExportRow-style keys.
const IMPORT_COLUMN_MAP: Record<string, keyof ExportRow> = {
  offeringname: "offeringName",
  offering: "offeringName",
  name: "offeringName",
  description: "description",
  desc: "description",
  link: "link",
  url: "link",
  specialisation: "specialisationName",
  specialisationname: "specialisationName",
  specialization: "specialisationName",
  trainingtype: "trainingType",
  type: "trainingType",
  training: "trainingFullTitle",
  trainingfulltitle: "trainingFullTitle",
  fulltitle: "trainingFullTitle",
  quantityrequired: "quantityRequired",
  quantity: "quantityRequired",
  qty: "quantityRequired",
  alternatives: "alternatives",
  alternative: "alternatives",
};

function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface CompanyOpt {
  id: number;
  name: string;
}

export default function OfferingsAdminPage() {
  const router = useRouter();
  const companyScope = useCompanyScope();

  const [offerings, setOfferings] = useState<OfferingSummaryRow[]>([]);
  const [allRows, setAllRows] = useState<OfferingDataRow[]>([]);
  const [specialisations, setSpecialisations] = useState<SpecialisationRow[]>([]);
  const [companies, setCompanies] = useState<CompanyOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastImport, setLastImport] = useState<string | null>(null);

  const [showExport, setShowExport] = useState(false);
  const showCompanyColumn = companyScope.selected === "all";

  // New / Rename / Delete
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCompanyId, setNewCompanyId] = useState<number | "">("");
  const [newDescription, setNewDescription] = useState("");
  const [newLink, setNewLink] = useState("");
  const [newSpecIds, setNewSpecIds] = useState<number[]>([]);
  const [newError, setNewError] = useState("");
  const [renameTarget, setRenameTarget] = useState<OfferingSummaryRow | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<OfferingSummaryRow | null>(null);
  const [deleteError, setDeleteError] = useState("");

  // Import
  type ImportStep = "upload" | "preview" | "result";
  interface ImportResult {
    created: number;
    skipped: number;
    errors: { row: number; message: string }[];
  }
  const [showImport, setShowImport] = useState(false);
  const [importStep, setImportStep] = useState<ImportStep>("upload");
  const [importCompanyId, setImportCompanyId] = useState<number | "">("");
  const [importRows, setImportRows] = useState<Partial<ExportRow>[]>([]);
  const [importValidationErrors, setImportValidationErrors] = useState<{ row: number; message: string }[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importFileError, setImportFileError] = useState("");
  const [overwriteAck, setOverwriteAck] = useState(false);

  const fetchOfferings = useCallback(async () => {
    try {
      const res = await fetch(withCompany("/api/admin/offerings", companyScope.selected));
      if (res.ok) setOfferings(await res.json());
      else setError("Failed to load offerings");
    } catch {
      setError("Failed to load offerings");
    } finally {
      setLoading(false);
    }
  }, [companyScope.selected]);
  const fetchRows = useCallback(async () => {
    try {
      const res = await fetch(withCompany("/api/admin/offering-data", companyScope.selected));
      if (res.ok) setAllRows(await res.json());
    } catch { /* ignore */ }
  }, [companyScope.selected]);
  const fetchLastImport = useCallback(() => {
    // Show the last import for the selected company; system-wide under "All".
    const key = companyScope.selected === "all" ? "offerings" : `offerings:${companyScope.selected}`;
    fetch(`/api/import-metadata?key=${encodeURIComponent(key)}`)
      .then((r) => r.json())
      .then((d) => setLastImport(d?.timestamp ?? null))
      .catch(() => setLastImport(null));
  }, [companyScope.selected]);
  const fetchSpecialisations = async () => {
    try {
      const res = await fetch("/api/admin/specialisations");
      if (res.ok) setSpecialisations(await res.json());
    } catch { /* ignore */ }
  };
  const fetchCompanies = async () => {
    try {
      const res = await fetch("/api/companies");
      if (res.ok) setCompanies((await res.json()).companies ?? []);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetchSpecialisations();
    fetchCompanies();
  }, []);

  useEffect(() => {
    if (companyScope.loading) return;
    fetchOfferings();
    fetchRows();
    fetchLastImport();
  }, [companyScope.loading, fetchOfferings, fetchRows, fetchLastImport]);

  const handleNew = async () => {
    setNewError("");
    if (!newName.trim()) { setNewError("Offering name is required"); return; }
    if (newCompanyId === "") { setNewError("Please pick a company"); return; }
    const res = await fetch("/api/admin/offerings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), companyId: newCompanyId, description: newDescription.trim(), link: newLink.trim(), specialisationIds: newSpecIds }),
    });
    const result = await res.json();
    if (!res.ok) { setNewError(result.error || "Failed to create offering"); return; }
    setShowNew(false);
    router.push(`/admin/offerings/${encodeURIComponent(newName.trim())}?companyId=${newCompanyId}`);
  };

  const handleRename = async () => {
    setRenameError("");
    if (!renameTarget) return;
    const res = await fetch(`/api/admin/offerings/${encodeURIComponent(renameTarget.name)}?companyId=${renameTarget.companyId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName: renameValue.trim() }),
    });
    const result = await res.json();
    if (!res.ok) { setRenameError(result.error || "Failed to rename"); return; }
    setRenameTarget(null);
    fetchOfferings();
    fetchRows();
  };

  const handleDelete = async () => {
    setDeleteError("");
    if (!deleteTarget) return;
    const res = await fetch(`/api/admin/offerings/${encodeURIComponent(deleteTarget.name)}?companyId=${deleteTarget.companyId}`, { method: "DELETE" });
    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      setDeleteError(result.error || "Failed to delete");
      return;
    }
    setDeleteTarget(null);
    fetchOfferings();
    fetchRows();
  };

  // --- Export ---
  const buildExportRows = (): ExportRow[] => {
    const rows: ExportRow[] = [];
    for (const o of offerings) {
      const reqs = allRows.filter((r) => r.offeringId === o.id);
      const specNames = [...new Set([...o.specialisations, ...reqs.map((r) => r.specialisationName ?? "")].filter(Boolean))].sort();
      for (const spec of specNames) {
        const specReqs = reqs.filter((r) => r.specialisationName === spec);
        if (specReqs.length === 0) {
          rows.push({
            offeringName: o.name,
            companyName: o.companyName ?? "",
            description: o.description ?? "",
            link: o.link ?? "",
            specialisationName: spec,
            trainingType: "",
            trainingFullTitle: "",
            quantityRequired: "",
            alternatives: "",
          });
        } else {
          for (const r of specReqs) {
            rows.push({
              offeringName: o.name,
              companyName: o.companyName ?? "",
              description: o.description ?? "",
              link: o.link ?? "",
              specialisationName: spec,
              trainingType: r.trainingType ?? "",
              trainingFullTitle: r.trainingFullTitle ?? "",
              quantityRequired: r.quantityRequired,
              alternatives: r.alternatives.map((a) => a.trainingFullTitle).join(" | "),
            });
          }
        }
      }
    }
    return rows;
  };

  const doExport = (fmt: "csv" | "excel" | "pdf") => {
    const rows = buildExportRows();
    const filename = "offerings";
    if (fmt === "csv") exportToCsv(rows, exportColumns, filename);
    else if (fmt === "excel") exportToExcel(rows, exportColumns, filename);
    else exportToPdf(rows, exportColumns, filename);
    setShowExport(false);
  };

  const downloadTemplate = () => {
    const sample: ExportRow[] = [
      { offeringName: "Offering A", companyName: "", description: "Joint delivery capability", link: "https://example.com", specialisationName: "Specialisation A", trainingType: "Certification", trainingFullTitle: "Cert A", quantityRequired: 2, alternatives: "Cert B" },
      { offeringName: "Offering A", companyName: "", description: "Joint delivery capability", link: "https://example.com", specialisationName: "Specialisation B", trainingType: "Accreditation", trainingFullTitle: "Accred A", quantityRequired: 1, alternatives: "" },
    ];
    exportToCsv(sample, exportColumns, "offerings-template");
  };

  // --- Import ---
  const parseFileToRows = (file: File): Promise<Partial<ExportRow>[]> => {
    return new Promise((resolve, reject) => {
      const mapRow = (raw: Record<string, unknown>): Partial<ExportRow> => {
        const out: Partial<ExportRow> = {};
        for (const [header, value] of Object.entries(raw)) {
          const key = IMPORT_COLUMN_MAP[normaliseHeader(header)];
          if (key) (out as Record<string, unknown>)[key] = typeof value === "string" ? value.trim() : value;
        }
        return out;
      };
      if (file.name.endsWith(".csv")) {
        Papa.parse<Record<string, unknown>>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => resolve(res.data.map(mapRow)),
          error: reject,
        });
      } else {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const data = new Uint8Array(e.target?.result as ArrayBuffer);
            const wb = XLSX.read(data, { type: "array" });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
            resolve(json.map(mapRow));
          } catch (err) { reject(err); }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
      }
    });
  };

  const handleFile = async (file: File) => {
    setImportFileError("");
    if (importCompanyId === "") { setImportFileError("Please pick a company first"); return; }
    try {
      const rows = await parseFileToRows(file);
      if (rows.length === 0) { setImportFileError("No rows found in file"); return; }
      setImportRows(rows);
      // Dry-run validation.
      const res = await fetch("/api/admin/offerings/import?dryRun=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, companyId: importCompanyId }),
      });
      const result = await res.json();
      setImportValidationErrors(result.errors || []);
      setImportStep("preview");
    } catch {
      setImportFileError("Failed to parse file");
    }
  };

  const doImport = async () => {
    if (importCompanyId === "") return;
    setImportLoading(true);
    try {
      const res = await fetch("/api/admin/offerings/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: importRows, companyId: importCompanyId }),
      });
      const result = await res.json();
      setImportResult(result);
      setImportStep("result");
      fetchOfferings();
      fetchRows();
      fetchLastImport();
    } finally {
      setImportLoading(false);
    }
  };

  const resetImport = () => {
    setShowImport(false);
    setImportStep("upload");
    setImportCompanyId("");
    setImportRows([]);
    setImportValidationErrors([]);
    setImportResult(null);
    setImportFileError("");
    setOverwriteAck(false);
  };

  const toggleNewSpec = (id: number) => {
    setNewSpecIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Offerings"
        showBack
        helpSlug="offerings"
        rightContent={
          <div className="flex items-center gap-2">
            {lastImport && (
              <span className="text-sm text-gray-500">Last imported: {new Date(lastImport).toLocaleString()}</span>
            )}
            <button onClick={() => setShowImport(true)} className="flex items-center gap-1 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
              <Upload size={16} /> Import
            </button>
            <div className="relative">
              <button onClick={() => setShowExport((v) => !v)} className="flex items-center gap-1 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                <Download size={16} /> Export
              </button>
              {showExport && (
                <div className="absolute right-0 mt-1 w-40 bg-white border border-gray-200 rounded-lg shadow-lg z-10">
                  <button onClick={() => doExport("csv")} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-50">CSV</button>
                  <button onClick={() => doExport("excel")} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-50">Excel</button>
                  <button onClick={() => doExport("pdf")} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-50">PDF</button>
                </div>
              )}
            </div>
            <button onClick={() => {
              setShowNew(true);
              setNewName("");
              setNewCompanyId(
                companyScope.selected !== "all"
                  ? companyScope.selected
                  : companies.length === 1
                  ? companies[0].id
                  : ""
              );
              setNewDescription("");
              setNewLink("");
              setNewSpecIds([]);
              setNewError("");
            }} className="flex items-center gap-1 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <Plus size={16} /> New Offering
            </button>
          </div>
        }
      />

      {error && <div className="p-3 mb-4 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}

      {loading ? (
        <div className="text-gray-500">Loading…</div>
      ) : offerings.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Package size={40} className="mx-auto mb-3 opacity-40" />
          <p>No offerings yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {offerings.map((o) => (
            <div key={o.id} className="border border-gray-200 rounded-xl p-4 bg-white hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between">
                <Link href={`/admin/offerings/${encodeURIComponent(o.name)}?companyId=${o.companyId}`} className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Package size={18} className="text-blue-600 shrink-0" />
                    <h3 className="font-semibold text-gray-900 truncate">{o.name}</h3>
                  </div>
                  {showCompanyColumn && o.companyName && (
                    <span className="mt-1 inline-block px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded">{o.companyName}</span>
                  )}
                  {o.description && <p className="mt-1 text-sm text-gray-500 line-clamp-2">{o.description}</p>}
                  <p className="mt-2 text-xs text-gray-400">
                    {o.specialisations.length} specialisation{o.specialisations.length === 1 ? "" : "s"} · {o.requirementCount} requirement{o.requirementCount === 1 ? "" : "s"}
                  </p>
                </Link>
                <div className="flex items-center gap-1 ml-2">
                  <button onClick={() => { setRenameTarget(o); setRenameValue(o.name); setRenameError(""); }} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded" title="Rename">
                    <Pencil size={15} />
                  </button>
                  <button onClick={() => { setDeleteTarget(o); setDeleteError(""); }} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New Offering */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Offering">
        <div className="space-y-4">
          {newError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{newError}</div>}
          <div>
            <label className="block text-sm font-medium mb-1">Company</label>
            <select
              value={newCompanyId === "" ? "" : String(newCompanyId)}
              onChange={(e) => setNewCompanyId(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            >
              <option value="">-- Select a company --</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Offering Name</label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm" placeholder="e.g., Offering A" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea value={newDescription} onChange={(e) => setNewDescription(e.target.value)} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Link</label>
            <input value={newLink} onChange={(e) => setNewLink(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm" placeholder="https://…" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Specialisations</label>
            <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg p-2 space-y-1">
              {specialisations.length === 0 ? (
                <p className="text-xs text-gray-500 p-1">No specialisations defined yet. Create them under Admin → Specialisations.</p>
              ) : (
                specialisations.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm px-1 py-0.5 cursor-pointer hover:bg-gray-50 rounded">
                    <input type="checkbox" checked={newSpecIds.includes(s.id)} onChange={() => toggleNewSpec(s.id)} className="w-4 h-4" />
                    {s.name}
                  </label>
                ))
              )}
            </div>
            <p className="mt-1 text-xs text-gray-500">You can add the supporting trainings for each specialisation on the next screen.</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setShowNew(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={handleNew} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <Save size={16} /> Create
            </button>
          </div>
        </div>
      </Modal>

      {/* Rename */}
      <Modal open={renameTarget !== null} onClose={() => setRenameTarget(null)} title="Rename Offering">
        <div className="space-y-4">
          {renameError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{renameError}</div>}
          <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm" />
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setRenameTarget(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={handleRename} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"><Save size={16} /> Save</button>
          </div>
        </div>
      </Modal>

      {/* Delete */}
      <Modal open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="Delete Offering">
        <div className="space-y-4">
          {deleteError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{deleteError}</div>}
          <p className="text-sm text-gray-600">Delete <strong>{deleteTarget?.name}</strong> and all its requirements? This cannot be undone.</p>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={handleDelete} className="flex items-center gap-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"><Trash2 size={16} /> Delete</button>
          </div>
        </div>
      </Modal>

      {/* Import */}
      <Modal open={showImport} onClose={resetImport} title="Import Offerings">
        {importStep === "upload" && (
          <div className="space-y-4">
            {importFileError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{importFileError}</div>}
            <p className="text-sm text-gray-600">Upload a CSV or Excel file. Existing requirements for any offering named in the file are replaced. Offerings are imported into the selected company.</p>
            <div>
              <label className="block text-sm font-medium mb-1">Company</label>
              <select
                value={importCompanyId === "" ? "" : String(importCompanyId)}
                onChange={(e) => setImportCompanyId(e.target.value === "" ? "" : Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              >
                <option value="">-- Select a company --</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <button onClick={downloadTemplate} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800">
              <FileDown size={16} /> Download template
            </button>
            <input type="file" accept=".csv,.xlsx,.xls" disabled={importCompanyId === ""} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} className="block w-full text-sm disabled:opacity-50" />
          </div>
        )}
        {importStep === "preview" && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">{importRows.length} rows parsed. {importValidationErrors.length} error(s).</p>
            {importValidationErrors.length > 0 && (
              <div className="max-h-40 overflow-y-auto border border-amber-200 bg-amber-50 rounded-lg p-2 text-xs space-y-1">
                {importValidationErrors.map((e, i) => (
                  <div key={i} className="flex items-start gap-1 text-amber-800"><AlertCircle size={14} className="mt-0.5 shrink-0" /> Row {e.row}: {e.message}</div>
                ))}
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={overwriteAck} onChange={(e) => setOverwriteAck(e.target.checked)} className="w-4 h-4" />
              I understand existing requirements for the named offerings will be replaced.
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setImportStep("upload")} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button onClick={doImport} disabled={!overwriteAck || importLoading} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {importLoading ? "Importing…" : "Import"}
              </button>
            </div>
          </div>
        )}
        {importStep === "result" && importResult && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-green-700"><CheckCircle2 size={18} /> Imported {importResult.created} requirement(s). Skipped {importResult.skipped}.</div>
            {importResult.errors.length > 0 && (
              <div className="max-h-40 overflow-y-auto border border-amber-200 bg-amber-50 rounded-lg p-2 text-xs space-y-1">
                {importResult.errors.map((e, i) => (
                  <div key={i} className="text-amber-800">Row {e.row}: {e.message}</div>
                ))}
              </div>
            )}
            <div className="flex justify-end"><button onClick={resetImport} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Done</button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
