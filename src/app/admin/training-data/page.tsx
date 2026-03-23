"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { TrainingDataRow } from "@/types";
import {
  Plus,
  Trash2,
  Save,
  Upload,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  Search,
  X,
} from "lucide-react";
import Papa from "papaparse";
import * as XLSX from "xlsx";

const TRAINING_TYPES = ["Certification", "Accreditation", "InstructorLedTraining"];
const PRODUCT_TYPES = ["Cortex", "SASE", "Cloud", "Strata", "Foundation"];
const FUNCTION_TYPES = ["Sales", "PreSales", "Deployments"];

const TRAINING_TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
  InstructorLedTraining: "Instructor-Led Training",
};

const FUNCTION_TYPE_LABELS: Record<string, string> = {
  Sales: "Sales",
  PreSales: "Pre-Sales",
  Deployments: "Deployments",
};

// Known aliases that auto-resolve (case-insensitive)
const TRAINING_TYPE_ALIASES: Record<string, string> = {
  certification: "Certification",
  accreditation: "Accreditation",
  accreditations: "Accreditation",
  "instructor-led training": "InstructorLedTraining",
  instructorledtraining: "InstructorLedTraining",
  ilt: "InstructorLedTraining",
  certs: "Certification",
  cert: "Certification",
};

const PRODUCT_TYPE_ALIASES: Record<string, string> = {
  cortex: "Cortex",
  sase: "SASE",
  cloud: "Cloud",
  strata: "Strata",
  foundation: "Foundation",
};

const FUNCTION_TYPE_ALIASES: Record<string, string> = {
  sales: "Sales",
  "pre-sales": "PreSales",
  presales: "PreSales",
  deployments: "Deployments",
  deployment: "Deployments",
};

function resolveTrainingType(val: string): string | null {
  if (TRAINING_TYPES.includes(val)) return val;
  return TRAINING_TYPE_ALIASES[val.toLowerCase()] ?? null;
}

function resolveProductType(val: string): string | null {
  if (PRODUCT_TYPES.includes(val)) return val;
  return PRODUCT_TYPE_ALIASES[val.toLowerCase()] ?? null;
}

function resolveFunctionType(val: string): string | null {
  if (FUNCTION_TYPES.includes(val)) return val;
  return FUNCTION_TYPE_ALIASES[val.toLowerCase()] ?? null;
}

const TARGET_FIELDS = [
  { key: "trainingTitle", label: "Training Title", required: true },
  { key: "fullTitle", label: "Full Title", required: true },
  { key: "trainingType", label: "Training Type", required: false },
  { key: "productType", label: "Product Type", required: false },
  { key: "function", label: "Function", required: false },
  { key: "link", label: "Link", required: false },
];

type ImportStep = "upload" | "mapping" | "resolve" | "importing" | "summary";

interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

// Tracks unrecognized values for a given enum field
interface UnrecognizedValue {
  value: string;       // the raw value from the file
  count: number;       // how many rows have this value
  mappedTo: string;    // what the user chose to map it to
}

export default function TrainingDataPage() {
  const [trainingList, setTrainingList] = useState<TrainingDataRow[]>([]);
  const [showAddTraining, setShowAddTraining] = useState(false);
  const [newTraining, setNewTraining] = useState({
    trainingTitle: "",
    fullTitle: "",
    trainingType: "Certification",
    productType: "Cortex",
    function: "Sales",
    link: "",
  });
  const [loading, setLoading] = useState(true);

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTrainingType, setFilterTrainingType] = useState("");
  const [filterProductType, setFilterProductType] = useState("");
  const [filterFunction, setFilterFunction] = useState("");

  // Editing state
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({
    trainingTitle: "",
    fullTitle: "",
    trainingType: "",
    productType: "",
    function: "",
    link: "",
  });

  // Import state
  const [showImport, setShowImport] = useState(false);
  const [importStep, setImportStep] = useState<ImportStep>("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState({
    trainingType: "Certification",
    productType: "Cortex",
    function: "Sales",
  });
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Value resolution state
  const [unresolvedTrainingTypes, setUnresolvedTrainingTypes] = useState<UnrecognizedValue[]>([]);
  const [unresolvedProductTypes, setUnresolvedProductTypes] = useState<UnrecognizedValue[]>([]);
  const [unresolvedFunctions, setUnresolvedFunctions] = useState<UnrecognizedValue[]>([]);

  useEffect(() => {
    fetchRawTrainingData();
  }, []);

  const fetchRawTrainingData = async () => {
    const res = await fetch("/api/training-data/all");
    if (res.ok) {
      const data = await res.json();
      setTrainingList(data);
    }
    setLoading(false);
  };

  const handleAddTraining = async () => {
    if (!newTraining.trainingTitle || !newTraining.fullTitle) return;
    const res = await fetch("/api/training-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newTraining),
    });
    if (res.ok) {
      setShowAddTraining(false);
      setNewTraining({
        trainingTitle: "",
        fullTitle: "",
        trainingType: "Certification",
        productType: "Cortex",
        function: "Sales",
        link: "",
      });
      fetchRawTrainingData();
    }
  };

  const handleDeleteTraining = async (trainingTitle: string) => {
    const res = await fetch(
      `/api/training-data/${encodeURIComponent(trainingTitle)}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      setTrainingList((prev) =>
        prev.filter((t) => t.trainingTitle !== trainingTitle)
      );
    }
  };

  const handleUpdateTraining = async (originalTitle: string) => {
    const res = await fetch(
      `/api/training-data/${encodeURIComponent(originalTitle)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editValues),
      }
    );
    if (res.ok) {
      setEditingTitle(null);
      fetchRawTrainingData();
    }
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
          // Read header row separately to capture ALL columns, even those empty in the first data rows
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
    const mapping: Record<string, string> = {};
    for (const field of TARGET_FIELDS) {
      const normalized = field.label.toLowerCase().replace(/[^a-z]/g, "");
      const match = hdrs.find(
        (h) => h.toLowerCase().replace(/[^a-z]/g, "") === normalized
      );
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

  // Scan rows for unrecognized enum values and move to resolve step if needed
  const proceedFromMapping = () => {
    const missingFields = TARGET_FIELDS.filter(
      (f) => f.required && !columnMapping[f.key]
    );
    if (missingFields.length > 0) {
      setImportError(
        `Please map the following required fields: ${missingFields.map((f) => f.label).join(", ")}`
      );
      return;
    }
    setImportError(null);

    // Collect unique values for each mapped enum field and find unrecognized ones
    const ttUnresolved: UnrecognizedValue[] = [];
    const ptUnresolved: UnrecognizedValue[] = [];
    const fnUnresolved: UnrecognizedValue[] = [];

    if (columnMapping.trainingType) {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const val = row[columnMapping.trainingType]?.trim();
        if (val) counts.set(val, (counts.get(val) || 0) + 1);
      }
      for (const [val, count] of counts) {
        if (!resolveTrainingType(val)) {
          ttUnresolved.push({ value: val, count, mappedTo: TRAINING_TYPES[0] });
        }
      }
    }

    if (columnMapping.productType) {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const val = row[columnMapping.productType]?.trim();
        if (val) counts.set(val, (counts.get(val) || 0) + 1);
      }
      for (const [val, count] of counts) {
        if (!resolveProductType(val)) {
          ptUnresolved.push({ value: val, count, mappedTo: PRODUCT_TYPES[0] });
        }
      }
    }

    if (columnMapping.function) {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const val = row[columnMapping.function]?.trim();
        if (val) counts.set(val, (counts.get(val) || 0) + 1);
      }
      for (const [val, count] of counts) {
        if (!resolveFunctionType(val)) {
          fnUnresolved.push({ value: val, count, mappedTo: FUNCTION_TYPES[0] });
        }
      }
    }

    setUnresolvedTrainingTypes(ttUnresolved);
    setUnresolvedProductTypes(ptUnresolved);
    setUnresolvedFunctions(fnUnresolved);

    if (ttUnresolved.length > 0 || ptUnresolved.length > 0 || fnUnresolved.length > 0) {
      setImportStep("resolve");
    } else {
      handleImport();
    }
  };

  // Apply value resolutions to rows and then import
  const proceedFromResolve = () => {
    // Build replacement maps from user selections
    const trainingTypeMap = new Map<string, string>();
    for (const u of unresolvedTrainingTypes) {
      trainingTypeMap.set(u.value, u.mappedTo);
    }
    const productTypeMap = new Map<string, string>();
    for (const u of unresolvedProductTypes) {
      productTypeMap.set(u.value, u.mappedTo);
    }
    const functionMap = new Map<string, string>();
    for (const u of unresolvedFunctions) {
      functionMap.set(u.value, u.mappedTo);
    }

    // Apply replacements to row data
    const updatedRows = rows.map((row) => {
      const newRow = { ...row };
      if (columnMapping.trainingType) {
        const val = newRow[columnMapping.trainingType]?.trim();
        if (val && trainingTypeMap.has(val)) {
          newRow[columnMapping.trainingType] = trainingTypeMap.get(val)!;
        }
      }
      if (columnMapping.productType) {
        const val = newRow[columnMapping.productType]?.trim();
        if (val && productTypeMap.has(val)) {
          newRow[columnMapping.productType] = productTypeMap.get(val)!;
        }
      }
      if (columnMapping.function) {
        const val = newRow[columnMapping.function]?.trim();
        if (val && functionMap.has(val)) {
          newRow[columnMapping.function] = functionMap.get(val)!;
        }
      }
      return newRow;
    });

    setRows(updatedRows);
    handleImport(updatedRows);
  };

  const handleImport = async (importRows?: Record<string, string>[]) => {
    setImportStep("importing");
    setImportError(null);

    const dataRows = importRows ?? rows;

    try {
      const res = await fetch("/api/training-data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: dataRows, columnMapping, defaults }),
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
      fetchRawTrainingData();
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
    setDefaults({ trainingType: "Certification", productType: "Cortex", function: "Sales" });
    setImportSummary(null);
    setImportError(null);
    setUnresolvedTrainingTypes([]);
    setUnresolvedProductTypes([]);
    setUnresolvedFunctions([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const closeImport = () => {
    setShowImport(false);
    resetImport();
  };

  // Check which optional enum fields are NOT mapped to a column
  const unmappedTrainingType = !columnMapping.trainingType;
  const unmappedProductType = !columnMapping.productType;
  const unmappedFunction = !columnMapping.function;
  const showDefaults = unmappedTrainingType || unmappedProductType || unmappedFunction;

  const totalUnresolved = unresolvedTrainingTypes.length + unresolvedProductTypes.length + unresolvedFunctions.length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading training data...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Training Data" showBack />

      {/* Import Section */}
      <section className="mb-6">
        {!showImport ? (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowImport(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Upload size={16} /> Import Training Data
            </button>
            <button
              onClick={() => setShowAddTraining(true)}
              className="flex items-center gap-1 px-3 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              <Plus size={16} /> Add Training
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Import Training Data</h3>
              <button
                onClick={closeImport}
                className="p-1 rounded hover:bg-gray-100"
              >
                <X size={18} />
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
                <p className="text-base font-medium text-gray-700 mb-1">
                  Drop your CSV or Excel file here
                </p>
                <p className="text-sm text-gray-500 mb-3">or click to browse files</p>
                <p className="text-xs text-gray-400">
                  Supported formats: .csv, .xls, .xlsx
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </div>
            )}

            {/* Step 2: Column Mapping */}
            {importStep === "mapping" && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <FileSpreadsheet size={18} className="text-blue-500" />
                  <span className="font-medium text-sm">{fileName}</span>
                  <span className="text-xs text-gray-500">
                    ({rows.length} rows, {headers.length} columns)
                  </span>
                </div>

                <div>
                  <h4 className="text-sm font-semibold mb-3">Map Columns</h4>
                  <p className="text-sm text-gray-600 mb-3">
                    Map columns from your file to the training data fields.
                    Training Title and Full Title are required. Unmapped columns will be discarded.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {TARGET_FIELDS.map((field) => (
                      <div key={field.key} className="flex items-center gap-3">
                        <label className="w-28 text-sm font-medium text-gray-700 shrink-0">
                          {field.label}
                          {field.required && <span className="text-red-500 ml-1">*</span>}
                        </label>
                        <select
                          value={columnMapping[field.key] || ""}
                          onChange={(e) =>
                            setColumnMapping((prev) => {
                              const next = { ...prev };
                              if (e.target.value) {
                                next[field.key] = e.target.value;
                              } else {
                                delete next[field.key];
                              }
                              return next;
                            })
                          }
                          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        >
                          <option value="">-- {field.required ? "Select column" : "Not mapped (use default)"} --</option>
                          {headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Default values for unmapped enum fields */}
                {showDefaults && (
                  <div className="bg-gray-50 rounded-lg p-4">
                    <h4 className="text-sm font-semibold mb-3">
                      Default Values for Unmapped Fields
                    </h4>
                    <p className="text-xs text-gray-500 mb-3">
                      These defaults will be applied to all imported rows where the field is not mapped to a column.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      {unmappedTrainingType && (
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">
                            Training Type
                          </label>
                          <select
                            value={defaults.trainingType}
                            onChange={(e) =>
                              setDefaults((prev) => ({ ...prev, trainingType: e.target.value }))
                            }
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                          >
                            {TRAINING_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {TRAINING_TYPE_LABELS[t]}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      {unmappedProductType && (
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">
                            Product Type
                          </label>
                          <select
                            value={defaults.productType}
                            onChange={(e) =>
                              setDefaults((prev) => ({ ...prev, productType: e.target.value }))
                            }
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                          >
                            {PRODUCT_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      {unmappedFunction && (
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">
                            Function
                          </label>
                          <select
                            value={defaults.function}
                            onChange={(e) =>
                              setDefaults((prev) => ({ ...prev, function: e.target.value }))
                            }
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                          >
                            {FUNCTION_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {FUNCTION_TYPE_LABELS[t]}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Preview */}
                {rows.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">
                      Preview (first 5 rows)
                    </h4>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border border-gray-200">
                        <thead>
                          <tr className="bg-gray-50">
                            {TARGET_FIELDS.map((f) => (
                              <th key={f.key} className="px-3 py-2 text-left border-b">
                                {f.label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.slice(0, 5).map((row, idx) => (
                            <tr key={idx} className="border-b">
                              {TARGET_FIELDS.map((f) => (
                                <td key={f.key} className="px-3 py-2 text-gray-600">
                                  {columnMapping[f.key]
                                    ? row[columnMapping[f.key]] || "-"
                                    : <span className="text-gray-300 italic">default</span>}
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
                  <button
                    onClick={resetImport}
                    className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
                  >
                    Back
                  </button>
                  <button
                    onClick={proceedFromMapping}
                    className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Resolve unrecognized values */}
            {importStep === "resolve" && (
              <div className="space-y-4">
                <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertTriangle size={18} className="text-amber-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-amber-800">
                      {totalUnresolved} unrecognized value{totalUnresolved !== 1 ? "s" : ""} found
                    </p>
                    <p className="text-xs text-amber-700 mt-1">
                      Select what each unrecognized value should be replaced with.
                      All rows with the same value will be updated automatically.
                    </p>
                  </div>
                </div>

                {unresolvedTrainingTypes.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">Training Type</h4>
                    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-gray-50 border-b">
                            <th className="px-4 py-2 text-left font-medium text-gray-600">Value in File</th>
                            <th className="px-4 py-2 text-left font-medium text-gray-600">Rows</th>
                            <th className="px-4 py-2 text-left font-medium text-gray-600">Replace With</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unresolvedTrainingTypes.map((u) => (
                            <tr key={u.value} className="border-b">
                              <td className="px-4 py-2">
                                <code className="bg-red-50 text-red-700 px-2 py-0.5 rounded text-xs">{u.value}</code>
                              </td>
                              <td className="px-4 py-2 text-gray-500">{u.count}</td>
                              <td className="px-4 py-2">
                                <select
                                  value={u.mappedTo}
                                  onChange={(e) =>
                                    setUnresolvedTrainingTypes((prev) =>
                                      prev.map((item) =>
                                        item.value === u.value
                                          ? { ...item, mappedTo: e.target.value }
                                          : item
                                      )
                                    )
                                  }
                                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
                                >
                                  {TRAINING_TYPES.map((t) => (
                                    <option key={t} value={t}>
                                      {TRAINING_TYPE_LABELS[t]}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {unresolvedProductTypes.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">Product Type</h4>
                    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-gray-50 border-b">
                            <th className="px-4 py-2 text-left font-medium text-gray-600">Value in File</th>
                            <th className="px-4 py-2 text-left font-medium text-gray-600">Rows</th>
                            <th className="px-4 py-2 text-left font-medium text-gray-600">Replace With</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unresolvedProductTypes.map((u) => (
                            <tr key={u.value} className="border-b">
                              <td className="px-4 py-2">
                                <code className="bg-red-50 text-red-700 px-2 py-0.5 rounded text-xs">{u.value}</code>
                              </td>
                              <td className="px-4 py-2 text-gray-500">{u.count}</td>
                              <td className="px-4 py-2">
                                <select
                                  value={u.mappedTo}
                                  onChange={(e) =>
                                    setUnresolvedProductTypes((prev) =>
                                      prev.map((item) =>
                                        item.value === u.value
                                          ? { ...item, mappedTo: e.target.value }
                                          : item
                                      )
                                    )
                                  }
                                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
                                >
                                  {PRODUCT_TYPES.map((t) => (
                                    <option key={t} value={t}>
                                      {t}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {unresolvedFunctions.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2">Function</h4>
                    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-gray-50 border-b">
                            <th className="px-4 py-2 text-left font-medium text-gray-600">Value in File</th>
                            <th className="px-4 py-2 text-left font-medium text-gray-600">Rows</th>
                            <th className="px-4 py-2 text-left font-medium text-gray-600">Replace With</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unresolvedFunctions.map((u) => (
                            <tr key={u.value} className="border-b">
                              <td className="px-4 py-2">
                                <code className="bg-red-50 text-red-700 px-2 py-0.5 rounded text-xs">{u.value}</code>
                              </td>
                              <td className="px-4 py-2 text-gray-500">{u.count}</td>
                              <td className="px-4 py-2">
                                <select
                                  value={u.mappedTo}
                                  onChange={(e) =>
                                    setUnresolvedFunctions((prev) =>
                                      prev.map((item) =>
                                        item.value === u.value
                                          ? { ...item, mappedTo: e.target.value }
                                          : item
                                      )
                                    )
                                  }
                                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
                                >
                                  {FUNCTION_TYPES.map((t) => (
                                    <option key={t} value={t}>
                                      {FUNCTION_TYPE_LABELS[t]}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => setImportStep("mapping")}
                    className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
                  >
                    Back
                  </button>
                  <button
                    onClick={proceedFromResolve}
                    className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Apply & Import {rows.length} Rows
                  </button>
                </div>
              </div>
            )}

            {/* Step 4: Importing */}
            {importStep === "importing" && (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mb-4" />
                <p className="text-gray-600">Importing {rows.length} rows...</p>
              </div>
            )}

            {/* Step 5: Summary */}
            {importStep === "summary" && importSummary && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <CheckCircle size={22} className="text-green-500" />
                  <h4 className="text-base font-semibold">Import Complete</h4>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-green-50 rounded-lg p-4 text-center">
                    <div className="text-2xl font-bold text-green-700">
                      {importSummary.imported}
                    </div>
                    <div className="text-sm text-green-600">New Records</div>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-4 text-center">
                    <div className="text-2xl font-bold text-blue-700">
                      {importSummary.updated}
                    </div>
                    <div className="text-sm text-blue-600">Updated</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4 text-center">
                    <div className="text-2xl font-bold text-gray-700">
                      {importSummary.skipped}
                    </div>
                    <div className="text-sm text-gray-600">Skipped</div>
                  </div>
                </div>

                {importSummary.errors.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-red-700 mb-2">
                      Errors ({importSummary.errors.length})
                    </h4>
                    <div className="max-h-48 overflow-y-auto bg-red-50 rounded-lg p-3">
                      {importSummary.errors.map((err, idx) => (
                        <div key={idx} className="text-sm text-red-600 py-1">
                          {err}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={closeImport}
                    className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
                  >
                    Done
                  </button>
                  <button
                    onClick={resetImport}
                    className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Import Another File
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Search and Filter */}
      <section className="mb-4 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search training titles..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg"
          />
        </div>
        <select
          value={filterTrainingType}
          onChange={(e) => setFilterTrainingType(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All Types</option>
          {TRAINING_TYPES.map((t) => (
            <option key={t} value={t}>{TRAINING_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <select
          value={filterProductType}
          onChange={(e) => setFilterProductType(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All Products</option>
          {PRODUCT_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={filterFunction}
          onChange={(e) => setFilterFunction(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All Functions</option>
          {FUNCTION_TYPES.map((t) => (
            <option key={t} value={t}>{FUNCTION_TYPE_LABELS[t]}</option>
          ))}
        </select>
      </section>

      {/* Training Data Table */}
      <section className="mb-8">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold">Training Title</th>
                  <th className="px-4 py-3 text-left font-semibold">Full Title</th>
                  <th className="px-4 py-3 text-left font-semibold">Type</th>
                  <th className="px-4 py-3 text-left font-semibold">Product</th>
                  <th className="px-4 py-3 text-left font-semibold">Function</th>
                  <th className="px-4 py-3 text-left font-semibold">Link</th>
                  <th className="px-4 py-3 text-left font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {trainingList
                  .filter((t) => {
                    const q = searchQuery.toLowerCase();
                    const matchesSearch = !searchQuery ||
                      t.trainingTitle.toLowerCase().includes(q) ||
                      t.fullTitle.toLowerCase().includes(q);
                    const matchesType = !filterTrainingType || t.trainingType === filterTrainingType;
                    const matchesProduct = !filterProductType || t.productType === filterProductType;
                    const matchesFunction = !filterFunction || t.function === filterFunction;
                    return matchesSearch && matchesType && matchesProduct && matchesFunction;
                  })
                  .map((t) => (
                  <tr key={t.trainingTitle} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3">
                      {editingTitle === t.trainingTitle ? (
                        <input
                          type="text"
                          value={editValues.trainingTitle}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, trainingTitle: e.target.value }))}
                          className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                        />
                      ) : (
                        t.trainingTitle
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editingTitle === t.trainingTitle ? (
                        <input
                          type="text"
                          value={editValues.fullTitle}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, fullTitle: e.target.value }))}
                          className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                        />
                      ) : (
                        t.fullTitle
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editingTitle === t.trainingTitle ? (
                        <select
                          value={editValues.trainingType}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, trainingType: e.target.value }))}
                          className="border border-gray-300 rounded px-2 py-1 text-sm"
                        >
                          {TRAINING_TYPES.map((tt) => (
                            <option key={tt} value={tt}>{TRAINING_TYPE_LABELS[tt]}</option>
                          ))}
                        </select>
                      ) : (
                        TRAINING_TYPE_LABELS[t.trainingType] || t.trainingType
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editingTitle === t.trainingTitle ? (
                        <select
                          value={editValues.productType}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, productType: e.target.value }))}
                          className="border border-gray-300 rounded px-2 py-1 text-sm"
                        >
                          {PRODUCT_TYPES.map((pt) => (
                            <option key={pt} value={pt}>{pt}</option>
                          ))}
                        </select>
                      ) : (
                        t.productType
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editingTitle === t.trainingTitle ? (
                        <select
                          value={editValues.function}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, function: e.target.value }))}
                          className="border border-gray-300 rounded px-2 py-1 text-sm"
                        >
                          {FUNCTION_TYPES.map((ft) => (
                            <option key={ft} value={ft}>{FUNCTION_TYPE_LABELS[ft]}</option>
                          ))}
                        </select>
                      ) : (
                        FUNCTION_TYPE_LABELS[t.function] || t.function
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editingTitle === t.trainingTitle ? (
                        <input
                          type="url"
                          value={editValues.link}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, link: e.target.value }))}
                          className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                          placeholder="https://..."
                        />
                      ) : t.link ? (
                        <a
                          href={t.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          Link
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {editingTitle === t.trainingTitle ? (
                          <>
                            <button
                              onClick={() => handleUpdateTraining(t.trainingTitle)}
                              className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200"
                            >
                              <Save size={14} />
                            </button>
                            <button
                              onClick={() => setEditingTitle(null)}
                              className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => {
                                setEditingTitle(t.trainingTitle);
                                setEditValues({
                                  trainingTitle: t.trainingTitle,
                                  fullTitle: t.fullTitle,
                                  trainingType: t.trainingType,
                                  productType: t.productType,
                                  function: t.function,
                                  link: t.link || "",
                                });
                              }}
                              className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeleteTraining(t.trainingTitle)}
                              className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {trainingList.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      No training data found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Add Training Modal */}
      <Modal
        open={showAddTraining}
        onClose={() => setShowAddTraining(false)}
        title="Add Training"
        actions={
          <>
            <button
              onClick={() => setShowAddTraining(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleAddTraining}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Add
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Training Title *</label>
            <input
              type="text"
              value={newTraining.trainingTitle}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, trainingTitle: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Full Title *</label>
            <input
              type="text"
              value={newTraining.fullTitle}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, fullTitle: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Training Type *</label>
            <select
              value={newTraining.trainingType}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, trainingType: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {TRAINING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TRAINING_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Product Type *</label>
            <select
              value={newTraining.productType}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, productType: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {PRODUCT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Function *</label>
            <select
              value={newTraining.function}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, function: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {FUNCTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FUNCTION_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Link</label>
            <input
              type="url"
              value={newTraining.link}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, link: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="https://..."
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
