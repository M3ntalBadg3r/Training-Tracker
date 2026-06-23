"use client";

import { useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  Download,
  Upload,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import Modal from "@/components/ui/Modal";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import {
  IMPORT_TARGET_FIELDS,
  importTargetFieldLabel,
  type ImportTargetFieldKey,
} from "@/lib/import-target-fields";

interface AliasRow {
  id: number;
  targetField: ImportTargetFieldKey;
  alias: string;
}

type ImportStep = "upload" | "mapping" | "importing" | "summary";

interface ImportSummary {
  imported: number;
  skipped: number;
  errors: string[];
}

const IMPORT_TARGET_FIELDS_FOR_FILE = [
  { key: "targetField", label: "Target Field", required: true },
  { key: "alias", label: "Alias", required: true },
] as const;

export default function ImportAliasesSection() {
  const [rows, setRows] = useState<AliasRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const load = async () => {
    try {
      const res = await fetch("/api/admin/import-aliases");
      if (!res.ok) {
        setError("Failed to load aliases");
        return;
      }
      setRows(await res.json());
      setError(null);
    } finally {
      setLoading(false);
    }
  };

  const fetchLastImport = () => {
    fetch("/api/import-metadata?key=import-aliases")
      .then((res) => res.json())
      .then((data) => {
        if (data?.timestamp) setLastImport(data.timestamp);
      })
      .catch(() => {});
  };

  useEffect(() => {
    load();
    fetchLastImport();
  }, []);

  // Import modal state
  const [showImport, setShowImport] = useState(false);
  const [importStep, setImportStep] = useState<ImportStep>("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [fileRows, setFileRows] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const autoMapColumns = (hdrs: string[]) => {
    const aliases: Record<string, string[]> = {
      targetField: ["targetfield", "field", "target"],
      alias: ["alias", "header", "value"],
    };
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    const mapping: Record<string, string> = {};
    for (const field of IMPORT_TARGET_FIELDS_FOR_FILE) {
      const wants = aliases[field.key];
      const match = hdrs.find((h) => wants.includes(norm(h)));
      if (match) mapping[field.key] = match;
    }
    setColumnMapping(mapping);
  };

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
            setImportError(
              `Parse errors: ${result.errors.map((e) => e.message).join(", ")}`
            );
            return;
          }
          const hdrs = result.meta.fields || [];
          setHeaders(hdrs);
          setFileRows(result.data as Record<string, string>[]);
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
          const allRows = XLSX.utils.sheet_to_json<string[]>(sheet, {
            header: 1,
            raw: false,
          });
          if (allRows.length < 2) {
            setImportError("No data found in file");
            return;
          }
          const hdrs = (allRows[0] || []).map((h) => String(h).trim()).filter(Boolean);
          const jsonData = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
            raw: false,
            defval: "",
          });
          setHeaders(hdrs);
          setFileRows(jsonData);
          autoMapColumns(hdrs);
          setImportStep("mapping");
        } catch (err) {
          setImportError(
            `Failed to parse Excel: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setImportError("Unsupported file type. Please upload a CSV or Excel file.");
    }
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

  const runImport = async () => {
    const missing = IMPORT_TARGET_FIELDS_FOR_FILE.filter(
      (f) => f.required && !columnMapping[f.key]
    );
    if (missing.length > 0) {
      setImportError(
        `Please map: ${missing.map((f) => f.label).join(", ")}`
      );
      return;
    }
    setImportStep("importing");
    setImportError(null);
    try {
      const res = await fetch("/api/admin/import-aliases/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: fileRows, columnMapping }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setImportError(data.error || "Import failed");
        setImportStep("mapping");
        return;
      }
      const result: ImportSummary = await res.json();
      setImportSummary(result);
      setImportStep("summary");
      load();
      fetchLastImport();
    } catch (err) {
      setImportError(
        `Import failed: ${err instanceof Error ? err.message : String(err)}`
      );
      setImportStep("mapping");
    }
  };

  const resetImport = () => {
    setImportStep("upload");
    setFileName("");
    setHeaders([]);
    setFileRows([]);
    setColumnMapping({});
    setImportSummary(null);
    setImportError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const closeImport = () => {
    setShowImport(false);
    resetImport();
  };

  // Export rows are flattened to {Target Field, Alias} so a round-trip
  // through the import flow works without manual remapping.
  const exportRows = rows.map((row) => ({
    targetField: importTargetFieldLabel(row.targetField),
    alias: row.alias,
  }));
  const exportColumns = [
    { key: "targetField" as const, header: "Target Field" },
    { key: "alias" as const, header: "Alias" },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading aliases...</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h2 className="text-lg font-semibold text-gray-900">Import Aliases</h2>
        <div className="flex items-center gap-2">
          {lastImport && (
            <span className="text-xs text-gray-500">
              Last imported: {new Date(lastImport).toLocaleString()}
            </span>
          )}
          <div className="relative">
            <button
              onClick={() => setShowExportMenu((v) => !v)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
            >
              <Download size={14} /> Export
            </button>
            {showExportMenu && (
              <div className="absolute right-0 mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg z-10">
                <button
                  onClick={() => {
                    exportToCsv(exportRows, exportColumns, "import-aliases");
                    setShowExportMenu(false);
                  }}
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg"
                >
                  Export as CSV
                </button>
                <button
                  onClick={() => {
                    exportToExcel(exportRows, exportColumns, "import-aliases");
                    setShowExportMenu(false);
                  }}
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
                >
                  Export as Excel
                </button>
                <button
                  onClick={() => {
                    exportToPdf(exportRows, exportColumns, "import-aliases");
                    setShowExportMenu(false);
                  }}
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg"
                >
                  Export as PDF
                </button>
              </div>
            )}
          </div>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            <Upload size={14} /> Import
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-500 mb-6">
        Header variants the student-import wizard recognises automatically. Each
        target field can have multiple aliases &mdash; e.g.{" "}
        <code className="text-xs">Email Address</code> and{" "}
        <code className="text-xs">Student Email</code> both map to{" "}
        <strong>Email Address</strong>. Matching is case-insensitive and ignores
        spaces and punctuation. Use <strong>Export</strong> to download the
        current list as CSV/Excel/PDF, or <strong>Import</strong> to upload a
        two-column file (Target Field, Alias).
      </p>

      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {IMPORT_TARGET_FIELDS.map((field) => (
          <FieldAliasGroup
            key={field.key}
            field={field}
            rows={rows.filter((r) => r.targetField === field.key)}
            onChange={load}
            onError={setError}
          />
        ))}
      </div>

      <Modal open={showImport} onClose={closeImport} title="Import Aliases" size="2xl">
        {importStep === "upload" && (
          <div className="space-y-4">
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-gray-300 rounded-lg p-10 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30"
            >
              <FileSpreadsheet size={36} className="mx-auto text-gray-400 mb-2" />
              <div className="text-sm text-gray-600">
                Drop a CSV / Excel file here, or click to browse.
              </div>
              <div className="text-xs text-gray-400 mt-1">
                Expected columns: <code>Target Field</code>, <code>Alias</code>.
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xls,.xlsx"
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>
            {importError && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2 flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5" /> {importError}
              </div>
            )}
          </div>
        )}

        {importStep === "mapping" && (
          <div className="space-y-4">
            <div className="text-sm text-gray-600">
              File: <strong>{fileName}</strong> &mdash; {fileRows.length} rows.
            </div>
            <div className="space-y-2">
              {IMPORT_TARGET_FIELDS_FOR_FILE.map((field) => (
                <div key={field.key} className="flex items-center gap-3">
                  <label className="text-sm font-medium text-gray-700 w-32">
                    {field.label}
                    {field.required && <span className="text-red-500"> *</span>}
                  </label>
                  <select
                    value={columnMapping[field.key] || ""}
                    onChange={(e) =>
                      setColumnMapping({ ...columnMapping, [field.key]: e.target.value })
                    }
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">-- Not mapped --</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="text-xs text-gray-500">
              The <strong>Target Field</strong> column accepts either the label
              (e.g. <code>Email Address</code>) or the key (e.g. <code>email</code>).
              Unknown values are reported as errors and skipped.
            </div>
            {importError && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2 flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5" /> {importError}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={resetImport}
                className="px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Back
              </button>
              <button
                onClick={runImport}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Import {fileRows.length} rows
              </button>
            </div>
          </div>
        )}

        {importStep === "importing" && (
          <div className="text-center py-10">
            <div className="text-sm text-gray-500">Importing...</div>
          </div>
        )}

        {importStep === "summary" && importSummary && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3">
              <CheckCircle size={16} />
              <span>
                Imported {importSummary.imported} alias
                {importSummary.imported === 1 ? "" : "es"}, skipped{" "}
                {importSummary.skipped} (duplicates or invalid).
              </span>
            </div>
            {importSummary.errors.length > 0 && (
              <div className="text-sm bg-amber-50 border border-amber-200 rounded-lg p-3">
                <div className="font-medium text-amber-800 mb-1">
                  Issues ({importSummary.errors.length})
                </div>
                <ul className="text-xs text-amber-800 list-disc pl-5 space-y-0.5 max-h-40 overflow-auto">
                  {importSummary.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={resetImport}
                className="px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Import another file
              </button>
              <button
                onClick={closeImport}
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

function FieldAliasGroup({
  field,
  rows,
  onChange,
  onError,
}: {
  field: { key: ImportTargetFieldKey; label: string };
  rows: AliasRow[];
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [newAlias, setNewAlias] = useState("");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    const trimmed = newAlias.trim();
    if (!trimmed) return;
    setAdding(true);
    onError(null);
    try {
      const res = await fetch("/api/admin/import-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetField: field.key, alias: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onError(data.error || "Failed to add alias");
        return;
      }
      setNewAlias("");
      onChange();
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <div className="text-sm font-medium text-gray-900 mb-2">{field.label}</div>
      <div className="space-y-1">
        {rows.length === 0 && (
          <div className="text-xs text-gray-400 italic">No aliases yet.</div>
        )}
        {rows.map((row) => (
          <AliasRowItem key={row.id} row={row} onChange={onChange} onError={onError} />
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={newAlias}
          onChange={(e) => setNewAlias(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="Add an alias..."
          className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={add}
          disabled={adding || !newAlias.trim()}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={14} /> Add
        </button>
      </div>
    </div>
  );
}

function AliasRowItem({
  row,
  onChange,
  onError,
}: {
  row: AliasRow;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.alias);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === row.alias) {
      setEditing(false);
      setValue(row.alias);
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(`/api/admin/import-aliases/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onError(data.error || "Failed to rename alias");
        return;
      }
      setEditing(false);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete alias "${row.alias}"?`)) return;
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(`/api/admin/import-aliases/${row.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onError(data.error || "Failed to delete alias");
        return;
      }
      onChange();
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 py-1">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setEditing(false);
              setValue(row.alias);
            }
          }}
          autoFocus
          className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={save}
          disabled={busy}
          className="p-1 text-green-700 hover:bg-green-50 rounded disabled:opacity-50"
          aria-label="Save"
        >
          <Check size={16} />
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setValue(row.alias);
          }}
          disabled={busy}
          className="p-1 text-gray-500 hover:bg-gray-100 rounded disabled:opacity-50"
          aria-label="Cancel"
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 py-1 px-2 rounded hover:bg-gray-50">
      <code className="text-sm text-gray-700">{row.alias}</code>
      <div className="flex items-center gap-1">
        <button
          onClick={() => setEditing(true)}
          disabled={busy}
          className="p-1 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50"
          aria-label="Rename"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={remove}
          disabled={busy}
          className="p-1 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
          aria-label="Delete"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
