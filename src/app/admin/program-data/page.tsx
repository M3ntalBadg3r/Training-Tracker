"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { ProgramDataRow, ProgramSummaryRow, ProgramTierRow } from "@/types";
import { trainingTypeLabel } from "@/lib/utils";
import {
  Plus,
  Trash2,
  Save,
  Download,
  Upload,
  FileDown,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Pencil,
} from "lucide-react";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import Papa from "papaparse";
import * as XLSX from "xlsx";

const LEVEL_LABELS: Record<string, string> = {
  Country: "Country",
  Theatre: "Theatre",
  Global: "Global",
};

export default function ProgramDataPage() {
  const router = useRouter();

  const [programs, setPrograms] = useState<ProgramSummaryRow[]>([]);
  const [allRows, setAllRows] = useState<ProgramDataRow[]>([]);
  const [allTiers, setAllTiers] = useState<ProgramTierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Export menu
  const [showExport, setShowExport] = useState(false);

  // New / Rename / Delete program
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIsTiered, setNewIsTiered] = useState(false);
  const [newDeploymentMode, setNewDeploymentMode] = useState("flat");
  const [newError, setNewError] = useState("");
  const [renameTarget, setRenameTarget] = useState<ProgramSummaryRow | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProgramSummaryRow | null>(null);
  const [deleteError, setDeleteError] = useState("");

  // Import
  type ImportStep = "upload" | "preview" | "result";
  interface ImportRow {
    programName?: string;
    specialisationName?: string;
    tierName?: string;
    purpose?: string;
    level?: string;
    trainingType?: string;
    trainingFullTitle?: string;
    quantityRequired?: string | number;
    minimumPerTheatre?: string | number | null;
    alternatives?: string;
    deploymentMode?: string;
    tierSortOrder?: string | number | null;
    tierSpecialisationsRequired?: string | number | null;
  }
  interface ImportResult {
    created: number;
    skipped: number;
    errors: { row: number; message: string }[];
  }
  const [showImport, setShowImport] = useState(false);
  const [importStep, setImportStep] = useState<ImportStep>("upload");
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importValidated, setImportValidated] = useState(false);
  const [importValidationErrors, setImportValidationErrors] = useState<{ row: number; message: string }[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importFileError, setImportFileError] = useState("");
  const [overwriteAck, setOverwriteAck] = useState(false);

  const [lastImport, setLastImport] = useState<string | null>(null);

  const fetchPrograms = async () => {
    try {
      const res = await fetch("/api/admin/program-data/program");
      if (res.ok) setPrograms(await res.json());
      else setError("Failed to load programs");
    } catch {
      setError("Failed to load programs");
    } finally {
      setLoading(false);
    }
  };

  const fetchRows = async () => {
    try {
      const res = await fetch("/api/admin/program-data");
      if (res.ok) setAllRows(await res.json());
    } catch { /* ignore */ }
  };

  const fetchTiers = async () => {
    try {
      const res = await fetch("/api/admin/program-tiers");
      if (res.ok) setAllTiers(await res.json());
    } catch { /* ignore */ }
  };

  const fetchLastImport = () => {
    fetch("/api/import-metadata?key=program-data")
      .then((res) => res.json())
      .then((d) => { if (d?.timestamp) setLastImport(d.timestamp); })
      .catch(() => {});
  };

  useEffect(() => {
    fetchPrograms();
    fetchRows();
    fetchTiers();
    fetchLastImport();
  }, []);

  // --- New / Rename / Delete program handlers ---
  const handleNewProgram = async () => {
    setNewError("");
    const trimmed = newName.trim();
    if (!trimmed) { setNewError("Program name is required"); return; }
    const res = await fetch("/api/admin/program-data/program", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed, isTiered: newIsTiered, deploymentMode: newDeploymentMode }),
    });
    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      setNewError(result.error || "Failed to create program");
      return;
    }
    setShowNew(false);
    setNewName("");
    setNewIsTiered(false);
    setNewDeploymentMode("flat");
    router.push(`/admin/program-data/${encodeURIComponent(trimmed)}`);
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    setRenameError("");
    const trimmed = renameValue.trim();
    if (!trimmed) { setRenameError("Program name is required"); return; }
    const res = await fetch(`/api/admin/program-data/program/${encodeURIComponent(renameTarget.name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName: trimmed }),
    });
    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      setRenameError(result.error || "Failed to rename program");
      return;
    }
    setRenameTarget(null);
    setRenameValue("");
    fetchPrograms();
    fetchRows();
  };

  const handleDeleteProgram = async () => {
    if (!deleteTarget) return;
    setDeleteError("");
    const res = await fetch(`/api/admin/program-data/program/${encodeURIComponent(deleteTarget.name)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      setDeleteError(result.error || "Failed to delete program");
      return;
    }
    setDeleteTarget(null);
    fetchPrograms();
    fetchRows();
  };

  const describe = (p: ProgramSummaryRow) => {
    const parts: string[] = [];
    parts.push(`${p.requirementCount} requirement${p.requirementCount === 1 ? "" : "s"}`);
    if (p.specialisations.length > 0) {
      parts.push(`${p.specialisations.length} specialisation${p.specialisations.length === 1 ? "" : "s"}`);
    }
    if (p.levels.length > 0) {
      parts.push(`levels: ${p.levels.map((l) => LEVEL_LABELS[l] || l).join(", ")}`);
    }
    if (p.isTiered) {
      parts.push(`tiered · ${p.tierCount} tier${p.tierCount === 1 ? "" : "s"}`);
    }
    return parts.join(" · ");
  };

  // --- Export (all programs) ---
  // The export round-trips the full program structure so a re-import restores it
  // exactly: the program-level Deployment Handling (deploymentMode) rides on every
  // row, and each tier carries its ladder Order + Specialisations Required. Tiers
  // that have no requirement rows (e.g. in "per achieved specialisation" mode) are
  // emitted as blank "tier-definition" rows so they survive the round-trip too.
  const exportColumns = [
    { key: "programName" as const, header: "Program Name" },
    { key: "specialisationName" as const, header: "Specialisation" },
    { key: "tierName" as const, header: "Tier" },
    { key: "purpose" as const, header: "Purpose" },
    { key: "level" as const, header: "Level" },
    { key: "trainingType" as const, header: "Training Type" },
    { key: "trainingFullTitle" as const, header: "Training" },
    { key: "quantityRequired" as const, header: "Quantity Required" },
    { key: "minimumPerTheatre" as const, header: "Min per Theatre" },
    { key: "alternatives" as const, header: "Alternatives" },
    { key: "deploymentMode" as const, header: "Deployment Handling" },
    { key: "tierOrder" as const, header: "Tier Order" },
    { key: "tierSpecialisationsRequired" as const, header: "Tier Specialisations Required" },
  ];

  interface ExportRow {
    programName: string;
    specialisationName: string;
    tierName: string;
    purpose: string;
    level: string;
    trainingType: string;
    trainingFullTitle: string;
    quantityRequired: string | number;
    minimumPerTheatre: string | number;
    alternatives: string;
    deploymentMode: string;
    tierOrder: string | number;
    tierSpecialisationsRequired: string | number;
  }

  const deploymentModeByProgram = new Map(programs.map((p) => [p.name, p.deploymentMode]));
  const tierById = new Map(allTiers.map((t) => [t.id, t]));
  const usedTierIds = new Set(allRows.map((r) => r.tierId).filter((id): id is number => id != null));

  const requirementExportRows: ExportRow[] = allRows.map((r) => {
    const tier = r.tierId != null ? tierById.get(r.tierId) : undefined;
    const altsLabel = r.alternatives && r.alternatives.length > 0
      ? r.alternatives.map((a) => a.trainingFullTitle).join("|")
      : "";
    return {
      programName: r.programName,
      specialisationName: r.specialisationName ?? "",
      tierName: r.tierName ?? "",
      purpose: r.purpose,
      level: r.level,
      trainingType: r.trainingType ? trainingTypeLabel(r.trainingType) : "—",
      trainingFullTitle: r.trainingFullTitle || "—",
      quantityRequired: r.quantityRequired,
      minimumPerTheatre: r.minimumPerTheatre ?? "—",
      alternatives: altsLabel,
      deploymentMode: deploymentModeByProgram.get(r.programName) ?? "",
      tierOrder: tier ? tier.sortOrder : "",
      tierSpecialisationsRequired: tier ? tier.specialisationsRequired : "",
    };
  });

  // Tier-definition rows for tiers with no requirement rows referencing them.
  const emptyTierExportRows: ExportRow[] = allTiers
    .filter((t) => !usedTierIds.has(t.id))
    .map((t) => ({
      programName: t.programName,
      specialisationName: "",
      tierName: t.name,
      purpose: "",
      level: "",
      trainingType: "",
      trainingFullTitle: "",
      quantityRequired: "",
      minimumPerTheatre: "",
      alternatives: "",
      deploymentMode: deploymentModeByProgram.get(t.programName) ?? "",
      tierOrder: t.sortOrder,
      tierSpecialisationsRequired: t.specialisationsRequired,
    }));

  const exportData: ExportRow[] = [...requirementExportRows, ...emptyTierExportRows].sort(
    (a, b) =>
      a.programName.localeCompare(b.programName) ||
      a.specialisationName.localeCompare(b.specialisationName) ||
      a.tierName.localeCompare(b.tierName)
  );

  // --- Import overwrite warning ---
  const hasExistingData = allRows.length > 0 || programs.length > 0;
  const importAffectedPrograms = [
    ...new Set(importRows.map((r) => r.programName?.trim()).filter((n): n is string => !!n)),
  ].sort();
  const needsOverwriteAck = hasExistingData && importAffectedPrograms.length > 0;

  // --- Import helpers ---
  const IMPORT_COLUMN_MAP: Record<string, keyof ImportRow> = {
    programname: "programName",
    program: "programName",
    specialisation: "specialisationName",
    specialization: "specialisationName",
    tier: "tierName",
    tiername: "tierName",
    purpose: "purpose",
    level: "level",
    trainingtype: "trainingType",
    type: "trainingType",
    training: "trainingFullTitle",
    trainingtitle: "trainingFullTitle",
    trainingname: "trainingFullTitle",
    quantity: "quantityRequired",
    qty: "quantityRequired",
    quantityrequired: "quantityRequired",
    required: "quantityRequired",
    minimumperthe: "minimumPerTheatre",
    minpertheatre: "minimumPerTheatre",
    mintheatre: "minimumPerTheatre",
    minimum: "minimumPerTheatre",
    mintheatremin: "minimumPerTheatre",
    alternatives: "alternatives",
    alternative: "alternatives",
    alts: "alternatives",
    oralternatives: "alternatives",
    deploymenthandling: "deploymentMode",
    deploymentmode: "deploymentMode",
    deployment: "deploymentMode",
    tierorder: "tierSortOrder",
    sortorder: "tierSortOrder",
    order: "tierSortOrder",
    tierspecialisationsrequired: "tierSpecialisationsRequired",
    specialisationsrequired: "tierSpecialisationsRequired",
    specsrequired: "tierSpecialisationsRequired",
  };

  const normaliseHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

  const mapHeaders = (headers: string[]): Record<string, keyof ImportRow> => {
    const map: Record<string, keyof ImportRow> = {};
    for (const h of headers) {
      const key = IMPORT_COLUMN_MAP[normaliseHeader(h)];
      if (key) map[h] = key;
    }
    return map;
  };

  const parseFileToRows = (file: File): Promise<ImportRow[]> => {
    return new Promise((resolve, reject) => {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (ext === "csv") {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (result) => {
            const headers = result.meta.fields ?? [];
            const headerMap = mapHeaders(headers);
            const rows: ImportRow[] = result.data.map((raw) => {
              const r: ImportRow = {};
              for (const [h, field] of Object.entries(headerMap)) {
                (r as Record<string, unknown>)[field] = (raw as Record<string, string>)[h] ?? "";
              }
              return r;
            });
            resolve(rows);
          },
          error: (err) => reject(new Error(err.message)),
        });
      } else if (ext === "xlsx" || ext === "xls") {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const wb = XLSX.read(e.target?.result, { type: "array" });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
            if (raw.length === 0) { resolve([]); return; }
            const headers = Object.keys(raw[0]);
            const headerMap = mapHeaders(headers);
            const rows: ImportRow[] = raw.map((r) => {
              const row: ImportRow = {};
              for (const [h, field] of Object.entries(headerMap)) {
                (row as Record<string, unknown>)[field] = r[h] ?? "";
              }
              return row;
            });
            resolve(rows);
          } catch (err) {
            reject(err);
          }
        };
        reader.readAsArrayBuffer(file);
      } else {
        reject(new Error("Unsupported file type. Use CSV, XLS, or XLSX."));
      }
    });
  };

  const handleImportFile = async (file: File) => {
    setImportFileError("");
    try {
      const rows = await parseFileToRows(file);
      setImportRows(rows);
      setImportValidated(false);
      setImportValidationErrors([]);
      setImportStep("preview");
    } catch (err) {
      setImportFileError(err instanceof Error ? err.message : "Failed to parse file");
    }
  };

  const handleValidate = async () => {
    setImportLoading(true);
    setImportValidationErrors([]);
    try {
      const res = await fetch("/api/admin/program-data/import?dryRun=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: importRows }),
      });
      const result = await res.json();
      setImportValidationErrors(result.errors ?? []);
      setImportValidated(true);
    } catch {
      setImportValidationErrors([{ row: 0, message: "Validation request failed" }]);
    } finally {
      setImportLoading(false);
    }
  };

  const handleImport = async () => {
    setImportLoading(true);
    try {
      const res = await fetch("/api/admin/program-data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: importRows }),
      });
      const result = await res.json();
      setImportResult(result);
      setImportStep("result");
      fetchPrograms();
      fetchRows();
      fetchTiers();
      fetchLastImport();
    } catch {
      setImportResult({ created: 0, skipped: importRows.length, errors: [{ row: 0, message: "Import request failed" }] });
      setImportStep("result");
    } finally {
      setImportLoading(false);
    }
  };

  const downloadTemplate = () => {
    const templateData = [
      {
        "Program Name": "Example Program",
        "Specialisation": "Example Specialisation",
        "Tier": "",
        "Purpose": "qualification",
        "Level": "Global",
        "Training Type": "Certification",
        "Training": "Example Certification",
        "Quantity Required": 30,
        "Minimum per Theatre": 6,
        "Alternatives": "",
        "Deployment Handling": "",
        "Tier Order": "",
        "Tier Specialisations Required": "",
      },
      {
        "Program Name": "Example Program",
        "Specialisation": "Example Specialisation",
        "Tier": "",
        "Purpose": "qualification",
        "Level": "Country",
        "Training Type": "Certification",
        "Training": "Example Certification",
        "Quantity Required": 2,
        "Minimum per Theatre": "",
        "Alternatives": "Alternative Training A|Alternative Training B",
        "Deployment Handling": "",
        "Tier Order": "",
        "Tier Specialisations Required": "",
      },
      {
        "Program Name": "Example Tiered Program",
        "Specialisation": "",
        "Tier": "Tier A",
        "Purpose": "",
        "Level": "",
        "Training Type": "",
        "Training": "",
        "Quantity Required": "",
        "Minimum per Theatre": "",
        "Alternatives": "",
        "Deployment Handling": "flat",
        "Tier Order": 1,
        "Tier Specialisations Required": 1,
      },
    ];
    const templateCols = [
      { key: "Program Name", header: "Program Name" },
      { key: "Specialisation", header: "Specialisation" },
      { key: "Tier", header: "Tier" },
      { key: "Purpose", header: "Purpose" },
      { key: "Level", header: "Level" },
      { key: "Training Type", header: "Training Type" },
      { key: "Training", header: "Training" },
      { key: "Quantity Required", header: "Quantity Required" },
      { key: "Minimum per Theatre", header: "Minimum per Theatre" },
      { key: "Alternatives", header: "Alternatives" },
      { key: "Deployment Handling", header: "Deployment Handling" },
      { key: "Tier Order", header: "Tier Order" },
      { key: "Tier Specialisations Required", header: "Tier Specialisations Required" },
    ];
    exportToCsv(templateData as never[], templateCols as never[], "program-data-import-template");
  };

  const resetImport = () => {
    setImportStep("upload");
    setImportRows([]);
    setImportValidated(false);
    setImportValidationErrors([]);
    setImportLoading(false);
    setImportResult(null);
    setImportFileError("");
    setOverwriteAck(false);
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="Program Data" showBack helpSlug="admin-program-data" />
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Program Data"
        showBack
        helpSlug="admin-program-data"
        rightContent={
          lastImport && (
            <span className="text-sm text-gray-500">
              Last imported: {new Date(lastImport).toLocaleString()}
            </span>
          )
        }
      />

      {/* Import / Export / New Program buttons */}
      <section className="mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { resetImport(); setShowImport(true); }}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
          >
            <Upload size={16} /> Import
          </button>
          <div className="relative">
            <button
              onClick={() => setShowExport((p) => !p)}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              <Download size={16} /> Export
            </button>
            {showExport && (
              <div className="absolute left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
                <button
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg"
                  onClick={() => { exportToCsv(exportData as never[], exportColumns as never[], "program-data"); setShowExport(false); }}
                >
                  Export as CSV
                </button>
                <button
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
                  onClick={() => { exportToExcel(exportData as never[], exportColumns as never[], "program-data"); setShowExport(false); }}
                >
                  Export as Excel
                </button>
                <button
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg"
                  onClick={() => { exportToPdf(exportData as never[], exportColumns as never[], "program-data"); setShowExport(false); }}
                >
                  Export as PDF
                </button>
              </div>
            )}
          </div>
          <button
            onClick={() => { setShowNew(true); setNewName(""); setNewError(""); }}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={16} /> New Program
          </button>
        </div>
      </section>

      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg">{error}</div>
      )}

      {/* Program cards */}
      {programs.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-12 text-center text-gray-500">
          No programs yet. Click &quot;New Program&quot; to create one, or import requirements.
        </div>
      ) : (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {programs.map((p) => (
            <div
              key={p.name}
              className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
            >
              <Link href={`/admin/program-data/${encodeURIComponent(p.name)}`} className="flex items-center gap-3 min-w-0 flex-1">
                <ClipboardList size={20} className="text-blue-600 shrink-0" />
                <div className="min-w-0">
                  <h3 className="font-semibold truncate">{p.name}</h3>
                  <p className="text-sm text-gray-500 truncate">{describe(p)}</p>
                </div>
              </Link>
              <div className="flex items-center gap-1 shrink-0 ml-2">
                <button
                  onClick={() => { setRenameTarget(p); setRenameValue(p.name); setRenameError(""); }}
                  className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                  title="Rename program"
                >
                  <Pencil size={16} />
                </button>
                <button
                  onClick={() => { setDeleteTarget(p); setDeleteError(""); }}
                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                  title="Delete program"
                >
                  <Trash2 size={16} />
                </button>
                <Link href={`/admin/program-data/${encodeURIComponent(p.name)}`} className="p-1.5 text-gray-400 hover:text-gray-700" title="Open program">
                  <ChevronRight size={20} />
                </Link>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* New Program Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Program">
        <div className="space-y-4">
          {newError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{newError}</div>}
          <div>
            <label className="block text-sm font-medium mb-1">Program Name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g., a partner compliance program"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              onKeyDown={(e) => { if (e.key === "Enter") handleNewProgram(); }}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="new-tiered"
              checked={newIsTiered}
              onChange={(e) => setNewIsTiered(e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor="new-tiered" className="text-sm">Tiered program (unlocks tiers by achieved specialisations)</label>
          </div>
          {newIsTiered && (
            <div>
              <label className="block text-sm font-medium mb-1">Deployment requirement handling</label>
              <select
                value={newDeploymentMode}
                onChange={(e) => setNewDeploymentMode(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              >
                <option value="flat">Flat — each tier lists its own deployment requirements</option>
                <option value="perAchievedSpecialisation">Per achieved specialisation — each achieved specialisation&apos;s deployment requirements must be met</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">You can change this later on the program&apos;s page.</p>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setShowNew(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={handleNewProgram} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <Save size={16} /> Create
            </button>
          </div>
        </div>
      </Modal>

      {/* Rename Program Modal */}
      <Modal open={renameTarget !== null} onClose={() => setRenameTarget(null)} title="Rename Program">
        {renameTarget && (
          <div className="space-y-4">
            {renameError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{renameError}</div>}
            <div>
              <label className="block text-sm font-medium mb-1">Program Name</label>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                onKeyDown={(e) => { if (e.key === "Enter") handleRename(); }}
              />
              <p className="mt-1 text-xs text-gray-500">
                Renames the program and all {renameTarget.requirementCount} of its requirement{renameTarget.requirementCount === 1 ? "" : "s"}.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setRenameTarget(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleRename} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                <Save size={16} /> Save
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Program Modal */}
      <Modal open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="Delete Program">
        {deleteTarget && (
          <div>
            {deleteError && <div className="mb-3 p-2 bg-red-50 text-red-700 rounded text-sm">{deleteError}</div>}
            <p className="text-sm mb-4">
              Are you sure you want to delete <strong>{deleteTarget.name}</strong>
              {deleteTarget.requirementCount > 0
                ? <> and all <strong>{deleteTarget.requirementCount}</strong> of its requirement{deleteTarget.requirementCount === 1 ? "" : "s"}</>
                : null}? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleDeleteProgram} className="flex items-center gap-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">
                <Trash2 size={16} /> Delete
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Import Modal */}
      <Modal
        open={showImport}
        onClose={() => { setShowImport(false); resetImport(); }}
        title="Import Program Data"
        size="2xl"
      >
        {/* Step 1: Upload */}
        {importStep === "upload" && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Upload a CSV or Excel file containing program requirements. Each row defines one requirement.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={downloadTemplate}
                className="flex items-center gap-1 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                <FileDown size={16} /> Download Template
              </button>
              <span className="text-xs text-gray-500">CSV template with example rows</span>
            </div>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) handleImportFile(f);
              }}
              className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center"
            >
              <Upload size={32} className="mx-auto mb-3 text-gray-400" />
              <p className="text-sm text-gray-600 mb-3">Drop a file here or click to browse</p>
              <label className="cursor-pointer">
                <span className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                  Choose File
                </span>
                <input
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleImportFile(file);
                    e.target.value = "";
                  }}
                />
              </label>
              <p className="text-xs text-gray-400 mt-2">Supports CSV, XLS, XLSX</p>
            </div>
            {importFileError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
                <AlertCircle size={16} className="shrink-0 mt-0.5" />
                {importFileError}
              </div>
            )}
            <div className="pt-1 text-xs text-gray-500 space-y-1">
              <p><strong>Expected columns:</strong> Program Name, Specialisation, Tier, Purpose, Level, Training Type, Training, Quantity Required, Minimum per Theatre, Deployment Handling, Tier Order, Tier Specialisations Required</p>
              <p>Training Type and Training are optional for Global-level rows with no specific training (these count compliant theatres).</p>
              <p>Programs, tiers, and specialisations are auto-created if they don&apos;t already exist.</p>
              <p><strong>Importing replaces</strong> the existing requirements of every program named in the file — it does not merge or add to them.</p>
            </div>
          </div>
        )}

        {/* Step 2: Preview */}
        {importStep === "preview" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">
                <strong>{importRows.length}</strong> row{importRows.length !== 1 ? "s" : ""} parsed from file.
              </p>
              <button
                onClick={() => { setImportStep("upload"); setImportValidated(false); setImportValidationErrors([]); }}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                ← Back
              </button>
            </div>

            <div className="overflow-x-auto max-h-[280px] overflow-y-auto border border-gray-200 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium text-gray-600">#</th>
                    <th className="px-2 py-2 text-left font-medium text-gray-600">Program</th>
                    <th className="px-2 py-2 text-left font-medium text-gray-600">Specialisation</th>
                    <th className="px-2 py-2 text-left font-medium text-gray-600">Level</th>
                    <th className="px-2 py-2 text-left font-medium text-gray-600">Type</th>
                    <th className="px-2 py-2 text-left font-medium text-gray-600">Training</th>
                    <th className="px-2 py-2 text-left font-medium text-gray-600">Qty</th>
                    <th className="px-2 py-2 text-left font-medium text-gray-600">Min/Theatre</th>
                  </tr>
                </thead>
                <tbody>
                  {importRows.slice(0, 10).map((row, i) => {
                    const rowError = importValidated ? importValidationErrors.find((e) => e.row === i + 1) : undefined;
                    return (
                      <tr
                        key={i}
                        className={`border-t border-gray-100 ${rowError ? "bg-red-50" : ""}`}
                      >
                        <td className="px-2 py-1.5 text-gray-400">{i + 1}</td>
                        <td className="px-2 py-1.5">{row.programName || <span className="text-red-400">—</span>}</td>
                        <td className="px-2 py-1.5">{row.specialisationName || <span className="text-red-400">—</span>}</td>
                        <td className="px-2 py-1.5">{row.level || <span className="text-red-400">—</span>}</td>
                        <td className="px-2 py-1.5">{row.trainingType || "—"}</td>
                        <td className="px-2 py-1.5 max-w-[160px] truncate">{row.trainingFullTitle || "—"}</td>
                        <td className="px-2 py-1.5">{String(row.quantityRequired ?? "—")}</td>
                        <td className="px-2 py-1.5">{row.minimumPerTheatre != null && row.minimumPerTheatre !== "" ? String(row.minimumPerTheatre) : "—"}</td>
                      </tr>
                    );
                  })}
                  {importRows.length > 10 && (
                    <tr className="border-t border-gray-100 bg-gray-50">
                      <td colSpan={8} className="px-2 py-2 text-center text-gray-400 text-xs">
                        … and {importRows.length - 10} more rows
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {importValidated && importValidationErrors.length > 0 && (
              <div className="space-y-1 max-h-[120px] overflow-y-auto">
                {importValidationErrors.map((e, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 bg-red-50 text-red-700 rounded text-xs">
                    <AlertCircle size={14} className="shrink-0 mt-0.5" />
                    <span>Row {e.row}: {e.message}</span>
                  </div>
                ))}
              </div>
            )}

            {importValidated && importValidationErrors.length === 0 && (
              <div className="flex items-center gap-2 p-2 bg-green-50 text-green-700 rounded text-sm">
                <CheckCircle2 size={16} />
                All rows validated successfully.
              </div>
            )}

            {needsOverwriteAck && (
              <div className="space-y-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                <div className="flex items-start gap-2">
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Existing requirements will be replaced.</p>
                    <p className="mt-0.5">
                      Importing replaces all existing requirements for{" "}
                      <strong>{importAffectedPrograms.length === 1 ? importAffectedPrograms[0] : `${importAffectedPrograms.length} programs`}</strong>
                      {importAffectedPrograms.length > 1 && (
                        <> ({importAffectedPrograms.join(", ")})</>
                      )}
                      {" "}with the rows in this file. Programs not in the file are left untouched.
                    </p>
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={overwriteAck}
                    onChange={(e) => setOverwriteAck(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <span>I understand existing requirements for these programs will be replaced.</span>
                </label>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              {!importValidated && (
                <button
                  onClick={handleValidate}
                  disabled={importLoading}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  {importLoading ? "Validating…" : "Validate"}
                </button>
              )}
              <button
                onClick={handleImport}
                disabled={importLoading || (importValidated && importValidationErrors.length > 0) || (needsOverwriteAck && !overwriteAck)}
                className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                <Upload size={16} />
                {importLoading ? "Importing…" : "Import"}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Result */}
        {importStep === "result" && importResult && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-green-50 rounded-lg text-center">
                <p className="text-2xl font-bold text-green-700">{importResult.created}</p>
                <p className="text-sm text-green-600">Requirements imported</p>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg text-center">
                <p className="text-2xl font-bold text-gray-600">{importResult.skipped}</p>
                <p className="text-sm text-gray-500">Rows skipped</p>
              </div>
            </div>
            {importResult.errors.length > 0 && (
              <div className="space-y-1 max-h-[160px] overflow-y-auto">
                <p className="text-sm font-medium text-red-700">Row errors:</p>
                {importResult.errors.map((e, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 bg-red-50 text-red-700 rounded text-xs">
                    <AlertCircle size={14} className="shrink-0 mt-0.5" />
                    <span>Row {e.row}: {e.message}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <button
                onClick={() => { setShowImport(false); resetImport(); }}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
