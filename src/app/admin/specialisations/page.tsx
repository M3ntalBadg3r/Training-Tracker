"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import {
  Plus,
  Pencil,
  Trash2,
  Award,
  Upload,
  Download,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  Search,
} from "lucide-react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useTableSort } from "@/hooks/useTableSort";

interface SpecialisationRow {
  id: number;
  name: string;
  usageCount: number;
}

const TARGET_FIELDS = [{ key: "name", label: "Name", required: true }];

type ImportStep = "upload" | "mapping" | "importing" | "summary";
type UsageFilter = "all" | "used" | "unused";

interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export default function SpecialisationsPage() {
  const [specialisations, setSpecialisations] = useState<SpecialisationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Search + filter
  const [search, setSearch] = useState("");
  const [usageFilter, setUsageFilter] = useState<UsageFilter>("all");

  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState("");

  const [editSpecialisation, setEditSpecialisation] = useState<SpecialisationRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editError, setEditError] = useState("");

  const [deleteSpecialisation, setDeleteSpecialisation] = useState<SpecialisationRow | null>(null);
  const [deleteError, setDeleteError] = useState("");

  // Import state
  const [showImport, setShowImport] = useState(false);
  const [importStep, setImportStep] = useState<ImportStep>("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchSpecialisations = () => {
    fetch("/api/admin/specialisations")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { setSpecialisations(data); setLoading(false); })
      .catch(() => setLoading(false));
  };

  const fetchLastImport = () => {
    fetch("/api/import-metadata?key=specialisations")
      .then((res) => res.json())
      .then((data) => { if (data?.timestamp) setLastImport(data.timestamp); })
      .catch(() => {});
  };

  useEffect(() => {
    fetchSpecialisations();
    fetchLastImport();
  }, []);

  // Apply search + usage filter, then sort.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return specialisations.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q)) return false;
      if (usageFilter === "used" && s.usageCount === 0) return false;
      if (usageFilter === "unused" && s.usageCount > 0) return false;
      return true;
    });
  }, [specialisations, search, usageFilter]);

  const { sorted, toggleSort, sortIndicator } = useTableSort<SpecialisationRow>(
    filtered,
    {
      name: (s) => s.name,
      usageCount: (s) => s.usageCount,
    },
    { defaultKey: "name", defaultDir: "asc", tiebreakKey: "name", descFirstKeys: ["usageCount"] }
  );

  const handleAdd = async () => {
    setAddError("");
    const res = await fetch("/api/admin/specialisations", {
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
    fetchSpecialisations();
  };

  const handleEdit = async () => {
    if (!editSpecialisation) return;
    setEditError("");
    const res = await fetch(`/api/admin/specialisations/${editSpecialisation.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName }),
    });
    const data = await res.json();
    if (!res.ok) {
      setEditError(data.error);
      return;
    }
    setEditSpecialisation(null);
    fetchSpecialisations();
  };

  const handleDelete = async () => {
    if (!deleteSpecialisation) return;
    setDeleteError("");
    const res = await fetch(`/api/admin/specialisations/${deleteSpecialisation.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json();
      setDeleteError(data.error);
      return;
    }
    setDeleteSpecialisation(null);
    fetchSpecialisations();
  };

  // Import handlers
  const parseFile = (file: File) => {
    setImportError(null);
    setFileName(file.name);
    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "csv") {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (result) => {
          if (result.errors.length > 0) {
            setImportError(`Parse errors: ${result.errors.map((e) => e.message).join(", ")}`);
            return;
          }
          const hdrs = result.meta.fields || [];
          setHeaders(hdrs);
          setRows(result.data as Record<string, string>[]);
          autoMapColumns(hdrs);
          setImportStep("mapping");
        },
        error: (err) => setImportError(`Failed to parse CSV: ${err.message}`),
      });
    } else if (ext === "xls" || ext === "xlsx") {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: "array" });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const allRows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false });
          if (allRows.length < 2) { setImportError("No data found in file"); return; }
          const hdrs = (allRows[0] || []).map((h) => String(h).trim()).filter(Boolean);
          const jsonData = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { raw: false, defval: "" });
          setHeaders(hdrs);
          setRows(jsonData);
          autoMapColumns(hdrs);
          setImportStep("mapping");
        } catch (err) {
          setImportError(`Failed to parse Excel: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setImportError("Unsupported file type. Please upload a CSV or Excel file.");
    }
  };

  const autoMapColumns = (hdrs: string[]) => {
    const aliases: Record<string, string[]> = {
      name: ["name", "specialisation", "specialization"],
    };
    const mapping: Record<string, string> = {};
    for (const field of TARGET_FIELDS) {
      const wants = aliases[field.key] ?? [field.label.toLowerCase()];
      const match = hdrs.find((h) => wants.includes(h.toLowerCase().replace(/[^a-z]/g, "")));
      if (match) mapping[field.key] = match;
    }
    setColumnMapping(mapping);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
  };

  const handleImport = async () => {
    const missingFields = TARGET_FIELDS.filter((f) => f.required && !columnMapping[f.key]);
    if (missingFields.length > 0) {
      setImportError(`Please map the following fields: ${missingFields.map((f) => f.label).join(", ")}`);
      return;
    }
    setImportStep("importing");
    setImportError(null);
    try {
      const res = await fetch("/api/admin/specialisations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, columnMapping }),
      });
      if (!res.ok) {
        const errorData = await res.json();
        setImportError(errorData.error || "Import failed");
        setImportStep("mapping");
        return;
      }
      const result = await res.json();
      setImportSummary(result);
      setImportStep("summary");
      fetchSpecialisations();
      fetchLastImport();
    } catch (err) {
      setImportError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      setImportStep("mapping");
    }
  };

  const resetImport = () => {
    setImportStep("upload");
    setFileName("");
    setHeaders([]);
    setRows([]);
    setColumnMapping({});
    setImportSummary(null);
    setImportError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const closeImport = () => {
    setShowImport(false);
    resetImport();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading specialisations...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Specialisations"
        showBack
        helpSlug="admin-specialisations"
        rightContent={lastImport && <span className="text-sm text-gray-500">Last imported: {new Date(lastImport).toLocaleString()}</span>}
      />

      {/* Toolbar */}
      <section className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
          >
            <Upload size={16} /> Import Specialisations
          </button>
          <div className="relative">
            <button
              onClick={() => setShowExportMenu((prev) => !prev)}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              <Download size={16} /> Export
            </button>
            {showExportMenu && (
              <div className="absolute left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
                <button onClick={() => { exportToCsv(sorted, [{ key: "name", header: "Name" }], "specialisations"); setShowExportMenu(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg">Export as CSV</button>
                <button onClick={() => { exportToExcel(sorted, [{ key: "name", header: "Name" }], "specialisations"); setShowExportMenu(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100">Export as Excel</button>
                <button onClick={() => { exportToPdf(sorted, [{ key: "name", header: "Name" }], "specialisations"); setShowExportMenu(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg">Export as PDF</button>
              </div>
            )}
          </div>
          <button
            onClick={() => {
              setAddName("");
              setAddError("");
              setShowAdd(true);
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={16} /> Add Specialisation
          </button>
        </div>

        {/* Search + filter */}
        <div className="flex flex-wrap items-center gap-3 mt-4">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search specialisations..."
              className="pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg w-64"
            />
          </div>
          <select
            value={usageFilter}
            onChange={(e) => setUsageFilter(e.target.value as UsageFilter)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="all">All specialisations</option>
            <option value="used">In use</option>
            <option value="unused">Unused</option>
          </select>
        </div>
      </section>

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
                onClick={() => toggleSort("usageCount")}
              >
                Used by programs{sortIndicator("usageCount")}
              </th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-gray-500">
                  {specialisations.length === 0 ? "No specialisations yet." : "No specialisations match your filters."}
                </td>
              </tr>
            )}
            {sorted.map((s) => (
              <tr key={s.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-700 font-medium">
                  <span className="inline-flex items-center gap-2">
                    <Award size={14} className="text-gray-400" />
                    {s.name}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-700">{s.usageCount}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        setEditSpecialisation(s);
                        setEditName(s.name);
                        setEditError("");
                      }}
                      className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                      title="Rename"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setDeleteSpecialisation(s);
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

      {/* Import Modal */}
      <Modal open={showImport} onClose={closeImport} title="Import Specialisations" size="xl">
        <div>
          <div className="flex justify-end mb-3">
            <button
              onClick={() => {
                const csv = "Name\nSpecialisation A\nSpecialisation B\nSpecialisation C";
                const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = "specialisations-template.csv";
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              <Download size={14} /> Download Template
            </button>
          </div>

          {importError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <AlertCircle size={18} className="text-red-500 mt-0.5 shrink-0" />
              <span className="text-red-700 text-sm">{importError}</span>
            </div>
          )}

          {/* Step 1: Upload */}
          {importStep === "upload" && (
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              className="border-2 border-dashed border-gray-300 rounded-lg p-10 text-center hover:border-blue-400 transition-colors cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={40} className="mx-auto text-gray-400 mb-3" />
              <p className="text-base font-medium text-gray-700 mb-1">Drop your CSV or Excel file here</p>
              <p className="text-sm text-gray-500 mb-3">or click to browse files</p>
              <p className="text-xs text-gray-400">Supported formats: .csv, .xls, .xlsx</p>
              <input ref={fileInputRef} type="file" accept=".csv,.xls,.xlsx" onChange={handleFileSelect} className="hidden" />
            </div>
          )}

          {/* Step 2: Column Mapping */}
          {importStep === "mapping" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <FileSpreadsheet size={18} className="text-blue-500" />
                <span className="font-medium text-sm">{fileName}</span>
                <span className="text-xs text-gray-500">({rows.length} rows, {headers.length} columns)</span>
              </div>
              <div>
                <h4 className="text-sm font-semibold mb-3">Map Columns</h4>
                <p className="text-sm text-gray-600 mb-3">
                  Map the Name column from your file. Names that already exist are skipped.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {TARGET_FIELDS.map((field) => (
                    <div key={field.key} className="flex items-center gap-3">
                      <label className="w-20 text-sm font-medium text-gray-700">
                        {field.label}
                        {field.required && <span className="text-red-500 ml-1">*</span>}
                      </label>
                      <select
                        value={columnMapping[field.key] || ""}
                        onChange={(e) => setColumnMapping((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      >
                        <option value="">-- Select column --</option>
                        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
              {rows.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Preview (first 5 rows)</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border border-gray-200">
                      <thead>
                        <tr className="bg-gray-50">
                          {TARGET_FIELDS.map((f) => <th key={f.key} className="px-3 py-2 text-left border-b">{f.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 5).map((row, idx) => (
                          <tr key={idx} className="border-b">
                            {TARGET_FIELDS.map((f) => (
                              <td key={f.key} className="px-3 py-2 text-gray-600">
                                {columnMapping[f.key] ? row[columnMapping[f.key]] || "-" : <span className="text-gray-300 italic">not mapped</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div className="flex gap-3 pt-2">
                <button onClick={resetImport} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Back</button>
                <button onClick={handleImport} className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Import {rows.length} Rows</button>
              </div>
            </div>
          )}

          {/* Step 3: Importing */}
          {importStep === "importing" && (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mb-4" />
              <p className="text-gray-600">Importing {rows.length} rows...</p>
            </div>
          )}

          {/* Step 4: Summary */}
          {importStep === "summary" && importSummary && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <CheckCircle size={22} className="text-green-500" />
                <h4 className="text-base font-semibold">Import Complete</h4>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-green-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-green-700">{importSummary.imported}</div>
                  <div className="text-sm text-green-600">New Specialisations</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-gray-700">{importSummary.skipped}</div>
                  <div className="text-sm text-gray-600">Skipped</div>
                </div>
              </div>
              {importSummary.errors.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-red-700 mb-2">Errors ({importSummary.errors.length})</h4>
                  <div className="max-h-48 overflow-y-auto bg-red-50 rounded-lg p-3">
                    {importSummary.errors.map((err, idx) => <div key={idx} className="text-sm text-red-600 py-1">{err}</div>)}
                  </div>
                </div>
              )}
              <div className="flex gap-3 pt-2">
                <button onClick={closeImport} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Done</button>
                <button onClick={resetImport} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Import Another File</button>
              </div>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add Specialisation"
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
        open={!!editSpecialisation}
        onClose={() => setEditSpecialisation(null)}
        title={`Edit Specialisation: ${editSpecialisation?.name}`}
        actions={
          <>
            <button onClick={() => setEditSpecialisation(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
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
        open={!!deleteSpecialisation}
        onClose={() => setDeleteSpecialisation(null)}
        title="Delete Specialisation"
        actions={
          <>
            <button onClick={() => setDeleteSpecialisation(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleDelete} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete</button>
          </>
        }
      >
        <p className="text-gray-600">
          Are you sure you want to delete <strong>{deleteSpecialisation?.name}</strong>? This cannot be undone.
        </p>
        {(deleteSpecialisation?.usageCount ?? 0) > 0 && (
          <p className="mt-2 text-sm text-amber-700">
            This specialisation is used by {deleteSpecialisation?.usageCount} program requirement(s) and cannot be deleted until those are removed.
          </p>
        )}
        {deleteError && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{deleteError}</div>
        )}
      </Modal>
    </div>
  );
}
