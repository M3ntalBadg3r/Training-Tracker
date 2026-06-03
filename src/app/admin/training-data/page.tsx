"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { TrainingDataRow } from "@/types";
import { useDebounce } from "@/hooks/useDebounce";
import {
  Plus,
  Trash2,
  Save,
  Upload,
  Download,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  Search,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";

const TRAINING_TYPES = ["Certification", "Accreditation", "InstructorLedTraining", "OLX", "OLXSubItem"];
const FUNCTION_TYPES = ["Sales", "PreSales", "Deployments"];

const TRAINING_TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
  InstructorLedTraining: "Instructor-Led Training",
  OLX: "OLX",
  OLXSubItem: "OLX Sub-Item",
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
  olx: "OLX",
  online: "OLX",
  "olx sub-item": "OLXSubItem",
  "olx subitem": "OLXSubItem",
  olxsubitem: "OLXSubItem",
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
  { key: "certification", label: "Certification", required: false },
  { key: "parentTrainingTitle", label: "Parent Training Title", required: false },
  { key: "legacy", label: "Legacy", required: false },
  { key: "replacement", label: "Replacement", required: false },
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
  // Product types are an admin-managed list, fetched at mount.
  const [productTypes, setProductTypes] = useState<string[]>([]);
  const [showAddTraining, setShowAddTraining] = useState(false);
  const [newTraining, setNewTraining] = useState({
    trainingTitle: "",
    fullTitle: "",
    trainingType: "Certification",
    productType: "",
    function: "Sales",
    link: "",
    certification: [] as string[],
    subItems: [] as string[],
    parents: [] as string[],
    isLegacy: false,
    replacedBy: [] as string[],
  });
  const [loading, setLoading] = useState(true);

  // Case-insensitive resolution of a raw product-type cell against the
  // configured list. Returns the canonical name or null when unknown.
  const resolveProductType = (val: string): string | null => {
    const match = productTypes.find((p) => p.toLowerCase() === val.trim().toLowerCase());
    return match ?? null;
  };
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Search and filter state (DataTable-style)
  const [searchTerm, setSearchTerm] = useState("");
  const [searchColumn, setSearchColumn] = useState("all");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [legacyOnly, setLegacyOnly] = useState(false);
  const [sortColumn, setSortColumn] = useState<string | null>("fullTitle");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const debouncedSearch = useDebounce(searchTerm);

  // trainingTitle → fullTitle map covering every row, so legacy `replacedBy`
  // arrays (which store internal trainingTitle keys) can be rendered as the
  // human-readable fullTitles shown elsewhere in the UI.
  const trainingTitleToFullTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of trainingList) m.set(t.trainingTitle, t.fullTitle);
    return m;
  }, [trainingList]);

  // Column definitions for search/filter (order matches desired table order)
  const tableColumns = useMemo(() => [
    { key: "fullTitle", header: "Full Title", filterable: true },
    { key: "trainingTitle", header: "Training Title", filterable: true },
    { key: "trainingType", header: "Type", filterable: true, filterOptions: TRAINING_TYPES, labelMap: TRAINING_TYPE_LABELS },
    { key: "link", header: "Link", filterable: false },
    { key: "productType", header: "Product", filterable: true, filterOptions: productTypes },
    { key: "function", header: "Function", filterable: true, filterOptions: FUNCTION_TYPES, labelMap: FUNCTION_TYPE_LABELS },
    { key: "certification", header: "Certification", filterable: true },
  ], [productTypes]);

  const getCellValue = (row: TrainingDataRow, key: string): string => {
    if (key === "certification") return row.certification?.join(", ") || "";
    if (key === "link") return row.link || "";
    return String((row as unknown as Record<string, unknown>)[key] ?? "");
  };

  // Map of parentTrainingTitle → sub-item rows (resolved through the join table
  // surfaced on each TrainingData row's `subItems` field).
  const subItemsByParent = useMemo(() => {
    const map = new Map<string, TrainingDataRow[]>();
    const byTitle = new Map(trainingList.map((t) => [t.trainingTitle, t]));
    for (const t of trainingList) {
      if (t.trainingType === "OLX" && t.subItems && t.subItems.length > 0) {
        const subs: TrainingDataRow[] = [];
        for (const subTitle of t.subItems) {
          const row = byTitle.get(subTitle);
          if (row) subs.push(row);
        }
        map.set(t.trainingTitle, subs);
      }
    }
    return map;
  }, [trainingList]);

  // Set of training titles that are sub-items of at least one parent — these
  // should be hidden from the top-level table and only appear nested.
  const subItemTitleSet = useMemo(() => {
    const set = new Set<string>();
    for (const subs of subItemsByParent.values()) {
      for (const s of subs) set.add(s.trainingTitle);
    }
    return set;
  }, [subItemsByParent]);

  const filteredTrainingList = useMemo(() => {
    // Hide sub-items from the top level — they're only visible nested under
    // their parent OLX.
    let result = trainingList.filter((t) => !t.isIncomplete && !subItemTitleSet.has(t.trainingTitle));

    // Free-form search
    if (debouncedSearch) {
      const term = debouncedSearch.toLowerCase();
      result = result.filter((row) => {
        if (searchColumn === "all") {
          return tableColumns.some((col) =>
            getCellValue(row, col.key).toLowerCase().includes(term)
          );
        }
        return getCellValue(row, searchColumn).toLowerCase().includes(term);
      });
    }

    // Column filters
    for (const [key, value] of Object.entries(columnFilters)) {
      if (!value) continue;
      result = result.filter(
        (row) => getCellValue(row, key).toLowerCase() === value.toLowerCase()
      );
    }

    // Legacy-only toggle: when on, restrict to retired Certs/Accreds. Used by
    // admins auditing which legacy items still need a replacement defined.
    if (legacyOnly) {
      result = result.filter((row) => row.isLegacy);
    }

    // Sorting
    if (sortColumn) {
      result.sort((a, b) => {
        const aVal = getCellValue(a, sortColumn);
        const bVal = getCellValue(b, sortColumn);
        const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
        return sortDirection === "asc" ? cmp : -cmp;
      });
    }

    return result;
  }, [trainingList, subItemTitleSet, debouncedSearch, searchColumn, columnFilters, legacyOnly, sortColumn, sortDirection, tableColumns]);

  const handleSort = (key: string) => {
    if (sortColumn === key) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(key);
      setSortDirection("asc");
    }
  };

  const handleColumnFilter = (key: string, value: string) => {
    setColumnFilters((prev) => ({ ...prev, [key]: value }));
  };

  const getFilterOptions = (col: { key: string; filterOptions?: string[] }): string[] => {
    if (col.filterOptions) return col.filterOptions;
    const values = new Set<string>();
    trainingList.forEach((row) => {
      const val = getCellValue(row, col.key);
      if (val) values.add(val);
    });
    return Array.from(values).sort();
  };

  // Editing state
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({
    trainingTitle: "",
    fullTitle: "",
    trainingType: "",
    productType: "",
    function: "",
    link: "",
    certification: [] as string[],
    subItems: [] as string[],
    parents: [] as string[],
    isLegacy: false,
    replacedBy: [] as string[],
  });

  // Tracks which OLX parents are expanded in the catalog view.
  const [expandedParents, setExpandedParents] = useState<Record<string, boolean>>({});

  // Incomplete entries
  const incompleteData = useMemo(() => trainingList.filter((t) => t.isIncomplete), [trainingList]);
  const [markingComplete, setMarkingComplete] = useState<string | null>(null);

  const handleMarkComplete = async (trainingTitle: string) => {
    setMarkingComplete(trainingTitle);
    await fetch(`/api/training-data/${encodeURIComponent(trainingTitle)}`, { method: "PATCH" });
    setMarkingComplete(null);
    fetchRawTrainingData();
  };

  // Import state
  const [showImport, setShowImport] = useState(false);
  const [importStep, setImportStep] = useState<ImportStep>("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState({
    trainingType: "Certification",
    productType: "",
    function: "Sales",
  });
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Value resolution state
  const [unresolvedTrainingTypes, setUnresolvedTrainingTypes] = useState<UnrecognizedValue[]>([]);
  const [unresolvedProductTypes, setUnresolvedProductTypes] = useState<UnrecognizedValue[]>([]);
  const [unresolvedFunctions, setUnresolvedFunctions] = useState<UnrecognizedValue[]>([]);

  const certificationOptions = useMemo(
    () =>
      trainingList
        .filter((t) => t.trainingType === "Certification")
        .map((t) => t.trainingTitle)
        .sort(),
    [trainingList]
  );

  // Replacement candidates for a legacy cert/accreditation — any Certification
  // or Accreditation. Callers exclude the row being edited.
  const replacementOptions = useMemo(
    () =>
      trainingList
        .filter((t) => t.trainingType === "Certification" || t.trainingType === "Accreditation")
        .map((t) => ({ trainingTitle: t.trainingTitle, fullTitle: t.fullTitle }))
        .sort((a, b) => a.fullTitle.localeCompare(b.fullTitle)),
    [trainingList]
  );

  // Available sub-item titles for OLX parent forms. Only OLXSubItem entries
  // are eligible — promote a training to OLXSubItem first if it should belong
  // to a parent.
  const subItemOptions = useMemo(
    () =>
      trainingList
        .filter((t) => t.trainingType === "OLXSubItem")
        .map((t) => ({ trainingTitle: t.trainingTitle, fullTitle: t.fullTitle }))
        .sort((a, b) => a.fullTitle.localeCompare(b.fullTitle)),
    [trainingList]
  );

  const parentOptions = useMemo(
    () =>
      trainingList
        .filter((t) => t.trainingType === "OLX")
        .map((t) => ({ trainingTitle: t.trainingTitle, fullTitle: t.fullTitle }))
        .sort((a, b) => a.fullTitle.localeCompare(b.fullTitle)),
    [trainingList]
  );

  // Flattens the row for export so the OLX parent column matches the import
  // format. parentTrainingTitle is comma-separated when a sub-item belongs to
  // multiple parents.
  const rowForExport = (t: TrainingDataRow) => ({
    trainingTitle: t.trainingTitle,
    fullTitle: t.fullTitle,
    trainingType: t.trainingType,
    productType: t.productType,
    function: t.function,
    link: t.link ?? "",
    certification: (t.certification ?? []).join(", "),
    parentTrainingTitle: (t.parents ?? []).join(", "),
    legacy: t.isLegacy ? "Yes" : "",
    replacement: (t.replacedBy ?? []).join(", "),
  });

  const fetchLastImport = () => {
    fetch("/api/import-metadata?key=training-data")
      .then((res) => res.json())
      .then((data) => {
        if (data?.timestamp) setLastImport(data.timestamp);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchRawTrainingData();
    fetchLastImport();
    fetchProductTypes();
  }, []);

  const fetchRawTrainingData = async () => {
    const res = await fetch("/api/training-data/all");
    if (res.ok) {
      const data = await res.json();
      setTrainingList(data);
    }
    setLoading(false);
  };

  const fetchProductTypes = async () => {
    const res = await fetch("/api/admin/product-types");
    if (res.ok) {
      const data: { name: string }[] = await res.json();
      const names = data.map((p) => p.name);
      setProductTypes(names);
      if (names.length > 0) {
        setNewTraining((prev) => (prev.productType ? prev : { ...prev, productType: names[0] }));
        setDefaults((prev) => (prev.productType ? prev : { ...prev, productType: names[0] }));
      }
    }
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
        productType: productTypes[0] ?? "",
        function: "Sales",
        link: "",
        certification: [],
        subItems: [],
        parents: [],
        isLegacy: false,
        replacedBy: [],
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
          ptUnresolved.push({ value: val, count, mappedTo: productTypes[0] ?? "" });
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
    setDefaults({ trainingType: "Certification", productType: productTypes[0] ?? "", function: "Sales" });
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
      <PageHeader
        title="Training Data"
        showBack
        helpSlug="training-data"
        rightContent={
          lastImport && (
            <span className="text-sm text-gray-500">
              Last imported: {new Date(lastImport).toLocaleString()}
            </span>
          )
        }
      />

      {/* Import Section */}
      <section className="mb-6">
        <div className="flex items-center gap-3">
            <button
              onClick={() => setShowImport(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              <Upload size={16} /> Import Training Data
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
                  <button
                    onClick={() => {
                      exportToCsv(trainingList.map(rowForExport), [
                        { key: "trainingTitle", header: "Training Title" },
                        { key: "fullTitle", header: "Full Title" },
                        { key: "trainingType", header: "Training Type" },
                        { key: "productType", header: "Product Type" },
                        { key: "function", header: "Function" },
                        { key: "link", header: "Link" },
                        { key: "certification", header: "Certification" },
                        { key: "parentTrainingTitle", header: "Parent Training Title" },
                        { key: "legacy", header: "Legacy" },
                        { key: "replacement", header: "Replacement" },
                      ], "training-data");
                      setShowExportMenu(false);
                    }}
                    className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg"
                  >
                    Export as CSV
                  </button>
                  <button
                    onClick={() => {
                      exportToExcel(trainingList.map(rowForExport), [
                        { key: "trainingTitle", header: "Training Title" },
                        { key: "fullTitle", header: "Full Title" },
                        { key: "trainingType", header: "Training Type" },
                        { key: "productType", header: "Product Type" },
                        { key: "function", header: "Function" },
                        { key: "link", header: "Link" },
                        { key: "certification", header: "Certification" },
                        { key: "parentTrainingTitle", header: "Parent Training Title" },
                        { key: "legacy", header: "Legacy" },
                        { key: "replacement", header: "Replacement" },
                      ], "training-data");
                      setShowExportMenu(false);
                    }}
                    className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
                  >
                    Export as Excel
                  </button>
                  <button
                    onClick={() => {
                      exportToPdf(trainingList.map(rowForExport), [
                        { key: "trainingTitle", header: "Training Title" },
                        { key: "fullTitle", header: "Full Title" },
                        { key: "trainingType", header: "Training Type" },
                        { key: "productType", header: "Product Type" },
                        { key: "function", header: "Function" },
                        { key: "link", header: "Link" },
                        { key: "certification", header: "Certification" },
                        { key: "parentTrainingTitle", header: "Parent Training Title" },
                        { key: "legacy", header: "Legacy" },
                        { key: "replacement", header: "Replacement" },
                      ], "training-data");
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
              onClick={() => setShowAddTraining(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Plus size={16} /> Add Training
            </button>
          </div>
      </section>

      {/* Import Modal */}
      <Modal open={showImport} onClose={closeImport} title="Import Training Data" size="2xl">
        <div>
          <div className="flex justify-end mb-3">
            <button
              onClick={() => {
                const pt = productTypes[0] ?? "Product Type";
                const csv = `Training Title,Full Title,Training Type,Product Type,Function,Link,Certification,Parent Training Title,Legacy,Replacement\nMY-CERT-001,My Certification Name,Certification,${pt},Sales,,,,,\nMY-CERT-OLD,My Legacy Certification,Certification,${pt},Sales,,,,Yes,MY-CERT-001\nMY-OLX-PARENT,My OLX Course,OLX,${pt},Sales,,My Cert,,,\nMY-OLX-SUB-1,Sub-Item 1,OLX Sub-Item,${pt},Sales,,,MY-OLX-PARENT,,`;
                const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = "training-data-template.csv";
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
                            {productTypes.map((t) => (
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
                                  {productTypes.map((t) => (
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
      </Modal>

      {/* Search bar */}
      <section className="mb-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <select
          value={searchColumn}
          onChange={(e) => setSearchColumn(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All columns</option>
          {tableColumns.map((col) => (
            <option key={col.key} value={col.key}>
              {col.header}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-700 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={legacyOnly}
            onChange={(e) => setLegacyOnly(e.target.checked)}
            className="rounded border-gray-300 text-orange-600 focus:ring-orange-500"
          />
          Show legacy only
        </label>
      </section>

      {/* Incomplete Training Entries */}
      {incompleteData.length > 0 && (
        <section className="mb-6">
          <div className="rounded-lg border border-amber-300 overflow-hidden">
            <div className="bg-amber-50 border-b border-amber-300 px-4 py-3 flex items-center gap-2">
              <AlertCircle size={18} className="text-amber-600 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-amber-800">
                  {incompleteData.length} training {incompleteData.length === 1 ? "entry" : "entries"} need attention
                </p>
                <p className="text-xs text-amber-700">
                  These were auto-created during import. Fill in the details and click &quot;Mark as Complete&quot; for each.
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-amber-50 border-b border-amber-200">
                    <th className="px-4 py-3 text-left font-semibold text-amber-800">Full Title</th>
                    <th className="px-4 py-3 text-left font-semibold text-amber-800">Training Title</th>
                    <th className="px-4 py-3 text-left font-semibold text-amber-800">Type</th>
                    <th className="px-4 py-3 text-left font-semibold text-amber-800">Link</th>
                    <th className="px-4 py-3 text-left font-semibold text-amber-800">Product</th>
                    <th className="px-4 py-3 text-left font-semibold text-amber-800">Function</th>
                    <th className="px-4 py-3 text-left font-semibold text-amber-800">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {incompleteData.map((t) => (
                    <tr key={t.trainingTitle} className="border-b border-amber-100 bg-amber-50/30 hover:bg-amber-50 transition-colors">
                      {/* Full Title */}
                      <td className="px-4 py-3">
                        {editingTitle === t.trainingTitle ? (
                          <input type="text" value={editValues.fullTitle}
                            onChange={(e) => setEditValues((prev) => ({ ...prev, fullTitle: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1 text-sm w-full" />
                        ) : t.fullTitle}
                      </td>
                      {/* Training Title */}
                      <td className="px-4 py-3">
                        {editingTitle === t.trainingTitle ? (
                          <input type="text" value={editValues.trainingTitle}
                            onChange={(e) => setEditValues((prev) => ({ ...prev, trainingTitle: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1 text-sm w-full" />
                        ) : t.trainingTitle}
                      </td>
                      {/* Type */}
                      <td className="px-4 py-3">
                        {editingTitle === t.trainingTitle ? (
                          <select value={editValues.trainingType}
                            onChange={(e) => { const val = e.target.value; setEditValues((prev) => ({ ...prev, trainingType: val, certification: (val === "InstructorLedTraining" || val === "OLX") ? prev.certification : [] })); }}
                            className="border border-gray-300 rounded px-2 py-1 text-sm">
                            {TRAINING_TYPES.map((tt) => <option key={tt} value={tt}>{TRAINING_TYPE_LABELS[tt]}</option>)}
                          </select>
                        ) : (TRAINING_TYPE_LABELS[t.trainingType] || t.trainingType)}
                      </td>
                      {/* Link */}
                      <td className="px-4 py-3">
                        {editingTitle === t.trainingTitle ? (
                          <input type="url" value={editValues.link}
                            onChange={(e) => setEditValues((prev) => ({ ...prev, link: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1 text-sm w-full" placeholder="https://..." />
                        ) : t.link ? (
                          <a href={t.link} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Link</a>
                        ) : "-"}
                      </td>
                      {/* Product */}
                      <td className="px-4 py-3">
                        {editingTitle === t.trainingTitle ? (
                          <select value={editValues.productType}
                            onChange={(e) => setEditValues((prev) => ({ ...prev, productType: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1 text-sm">
                            {productTypes.map((pt) => <option key={pt} value={pt}>{pt}</option>)}
                          </select>
                        ) : t.productType}
                      </td>
                      {/* Function */}
                      <td className="px-4 py-3">
                        {editingTitle === t.trainingTitle ? (
                          <select value={editValues.function}
                            onChange={(e) => setEditValues((prev) => ({ ...prev, function: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1 text-sm">
                            {FUNCTION_TYPES.map((ft) => <option key={ft} value={ft}>{FUNCTION_TYPE_LABELS[ft]}</option>)}
                          </select>
                        ) : (FUNCTION_TYPE_LABELS[t.function] || t.function)}
                      </td>
                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {editingTitle === t.trainingTitle ? (
                            <>
                              <button onClick={() => handleUpdateTraining(t.trainingTitle)}
                                className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700">Save</button>
                              <button onClick={() => setEditingTitle(null)}
                                className="px-2 py-1 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300">Cancel</button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => { setEditingTitle(t.trainingTitle); setEditValues({ trainingTitle: t.trainingTitle, fullTitle: t.fullTitle, trainingType: t.trainingType, productType: t.productType, function: t.function, link: t.link || "", certification: t.certification || [], subItems: t.subItems || [], parents: t.parents || [], isLegacy: t.isLegacy ?? false, replacedBy: t.replacedBy || [] }); }}
                                className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">Edit</button>
                              <button onClick={() => handleMarkComplete(t.trainingTitle)}
                                disabled={markingComplete === t.trainingTitle}
                                className="px-2 py-1 text-xs bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-50">
                                {markingComplete === t.trainingTitle ? "..." : "Mark as Complete"}
                              </button>
                              <button onClick={() => handleDeleteTraining(t.trainingTitle)}
                                className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200">
                                <Trash2 size={14} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Training Data Table */}
      <section className="mb-8">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {tableColumns.map((col) => (
                    <th key={col.key} className="px-4 py-3 text-left">
                      <div className="space-y-1">
                        <button
                          onClick={() => handleSort(col.key)}
                          className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900"
                        >
                          {col.header}
                          {sortColumn === col.key && (
                            sortDirection === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} />
                          )}
                        </button>
                        {col.filterable && (
                          <select
                            value={columnFilters[col.key] || ""}
                            onChange={(e) => handleColumnFilter(col.key, e.target.value)}
                            className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal"
                          >
                            <option value="">All</option>
                            {getFilterOptions(col).map((opt) => (
                              <option key={opt} value={opt}>
                                {col.labelMap ? (col.labelMap[opt] || opt) : opt}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </th>
                  ))}
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTrainingList.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                      No records found
                    </td>
                  </tr>
                ) : (
                  filteredTrainingList.flatMap((t) => {
                    const subs = subItemsByParent.get(t.trainingTitle) ?? [];
                    const isExpandable = subs.length > 0;
                    const isExpanded = isExpandable && !!expandedParents[t.trainingTitle];
                    const rows: React.ReactNode[] = [];
                    rows.push(
                  <tr key={t.trainingTitle} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    {/* Full Title */}
                    <td className="px-4 py-3">
                      {editingTitle === t.trainingTitle ? (
                        <input
                          type="text"
                          value={editValues.fullTitle}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, fullTitle: e.target.value }))}
                          className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                        />
                      ) : (
                        (() => {
                          const replFulls = t.isLegacy
                            ? (t.replacedBy ?? []).map((rt) => trainingTitleToFullTitle.get(rt) ?? rt)
                            : [];
                          const replTooltip = t.isLegacy
                            ? replFulls.length > 0
                              ? `Replaced by: ${replFulls.join(", ")}`
                              : "Legacy — no replacement defined"
                            : undefined;
                          return (
                            <div>
                              <div className="flex items-center gap-2">
                                {isExpandable && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedParents((prev) => ({
                                        ...prev,
                                        [t.trainingTitle]: !prev[t.trainingTitle],
                                      }))
                                    }
                                    className="text-gray-500 hover:text-gray-800"
                                    aria-label={isExpanded ? "Collapse sub-items" : "Expand sub-items"}
                                  >
                                    {isExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} className="rotate-90" />}
                                  </button>
                                )}
                                <span>{t.fullTitle}</span>
                                {t.isLegacy && (
                                  <span
                                    className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800"
                                    title={replTooltip}
                                  >
                                    Legacy
                                  </span>
                                )}
                                {isExpandable && (
                                  <span className="text-xs text-gray-500">({subs.length} sub-item{subs.length === 1 ? "" : "s"})</span>
                                )}
                              </div>
                              {t.isLegacy && (
                                replFulls.length > 0 ? (
                                  <div className="text-xs text-gray-500 mt-0.5 pl-0.5">
                                    → Replaced by: <span className="text-gray-700">{replFulls.join(", ")}</span>
                                  </div>
                                ) : (
                                  <div className="text-xs italic text-orange-700 mt-0.5 pl-0.5">
                                    → No replacement defined
                                  </div>
                                )
                              )}
                            </div>
                          );
                        })()
                      )}
                    </td>
                    {/* Training Title */}
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
                    {/* Type */}
                    <td className="px-4 py-3">
                      {editingTitle === t.trainingTitle ? (
                        <select
                          value={editValues.trainingType}
                          onChange={(e) => {
                            const val = e.target.value;
                            setEditValues((prev) => ({
                              ...prev,
                              trainingType: val,
                              certification: (val === "InstructorLedTraining" || val === "OLX") ? prev.certification : [],
                            }));
                          }}
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
                    {/* Link */}
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
                    {/* Product */}
                    <td className="px-4 py-3">
                      {editingTitle === t.trainingTitle ? (
                        <select
                          value={editValues.productType}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, productType: e.target.value }))}
                          className="border border-gray-300 rounded px-2 py-1 text-sm"
                        >
                          {productTypes.map((pt) => (
                            <option key={pt} value={pt}>{pt}</option>
                          ))}
                        </select>
                      ) : (
                        t.productType
                      )}
                    </td>
                    {/* Function */}
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
                    {/* Certification (available for ILT and OLX parents) */}
                    <td className="px-4 py-3">
                      {(t.trainingType === "InstructorLedTraining" || t.trainingType === "OLX") ? (
                        editingTitle === t.trainingTitle ? (
                          <div className="max-h-32 overflow-y-auto border border-gray-300 rounded px-2 py-1 text-sm space-y-1">
                            {certificationOptions.length === 0 && (
                              <span className="text-gray-400 text-xs">No certifications available</span>
                            )}
                            {certificationOptions.map((c) => (
                              <label key={c} className="flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 rounded px-1">
                                <input
                                  type="checkbox"
                                  checked={editValues.certification.includes(c)}
                                  onChange={(e) => {
                                    setEditValues((prev) => ({
                                      ...prev,
                                      certification: e.target.checked
                                        ? [...prev.certification, c]
                                        : prev.certification.filter((x) => x !== c),
                                    }));
                                  }}
                                  className="rounded border-gray-300"
                                />
                                <span className="text-xs">{c}</span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          t.certification.length > 0 ? t.certification.join(", ") : "-"
                        )
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
                    </td>
                    {/* Actions */}
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
                                  certification: t.certification || [],
                                  subItems: t.subItems || [],
                                  parents: t.parents || [],
                                  isLegacy: t.isLegacy ?? false,
                                  replacedBy: t.replacedBy || [],
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
                  );
                  // Inline editor extension: when editing a Certification or
                  // Accreditation, show a second row with the legacy controls.
                  if (editingTitle === t.trainingTitle && (editValues.trainingType === "Certification" || editValues.trainingType === "Accreditation")) {
                    rows.push(
                      <tr key={`${t.trainingTitle}::legacy-edit`} className="border-b border-gray-100 bg-blue-50/40">
                        <td colSpan={8} className="px-4 py-3">
                          <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-gray-600">
                            <input
                              type="checkbox"
                              checked={editValues.isLegacy}
                              onChange={(e) => setEditValues((prev) => ({ ...prev, isLegacy: e.target.checked, replacedBy: e.target.checked ? prev.replacedBy : [] }))}
                              className="rounded border-gray-300"
                            />
                            Mark as Legacy
                          </label>
                          {editValues.isLegacy && (
                            <div className="mt-2">
                              <div className="text-xs font-semibold text-gray-600 mb-1">Replaced by (optional — select one or more)</div>
                              <div className="max-h-40 overflow-y-auto border border-gray-200 rounded px-2 py-1 text-sm space-y-1 bg-white">
                                {replacementOptions.filter((r) => r.trainingTitle !== t.trainingTitle).length === 0 ? (
                                  <span className="text-gray-400 text-xs">No certifications/accreditations available.</span>
                                ) : replacementOptions.filter((r) => r.trainingTitle !== t.trainingTitle).map((r) => (
                                  <label key={r.trainingTitle} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1">
                                    <input
                                      type="checkbox"
                                      checked={editValues.replacedBy.includes(r.trainingTitle)}
                                      onChange={(e) => {
                                        setEditValues((prev) => ({
                                          ...prev,
                                          replacedBy: e.target.checked
                                            ? [...prev.replacedBy, r.trainingTitle]
                                            : prev.replacedBy.filter((x) => x !== r.trainingTitle),
                                        }));
                                      }}
                                      className="rounded border-gray-300"
                                    />
                                    <span className="text-xs">{r.fullTitle}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  }
                  // Inline editor extension: when editing an OLX or OLXSubItem,
                  // show a second row with the membership picker.
                  if (editingTitle === t.trainingTitle && (editValues.trainingType === "OLX" || editValues.trainingType === "OLXSubItem")) {
                    rows.push(
                      <tr key={`${t.trainingTitle}::membership-edit`} className="border-b border-gray-100 bg-blue-50/40">
                        <td colSpan={8} className="px-4 py-3">
                          {editValues.trainingType === "OLX" ? (
                            <div>
                              <div className="text-xs font-semibold text-gray-600 mb-1">Sub-Items (none = single-item OLX)</div>
                              <div className="max-h-40 overflow-y-auto border border-gray-200 rounded px-2 py-1 text-sm space-y-1 bg-white">
                                {subItemOptions.length === 0 ? (
                                  <span className="text-gray-400 text-xs">No OLX Sub-Item entries available.</span>
                                ) : subItemOptions.map((s) => (
                                  <label key={s.trainingTitle} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1">
                                    <input
                                      type="checkbox"
                                      checked={editValues.subItems.includes(s.trainingTitle)}
                                      onChange={(e) => {
                                        setEditValues((prev) => ({
                                          ...prev,
                                          subItems: e.target.checked
                                            ? [...prev.subItems, s.trainingTitle]
                                            : prev.subItems.filter((x) => x !== s.trainingTitle),
                                        }));
                                      }}
                                      className="rounded border-gray-300"
                                    />
                                    <span className="text-xs">{s.fullTitle}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div className="text-xs font-semibold text-gray-600 mb-1">Parent OLX (sub-item can belong to many)</div>
                              <div className="max-h-40 overflow-y-auto border border-gray-200 rounded px-2 py-1 text-sm space-y-1 bg-white">
                                {parentOptions.length === 0 ? (
                                  <span className="text-gray-400 text-xs">No OLX parent entries available.</span>
                                ) : parentOptions.map((p) => (
                                  <label key={p.trainingTitle} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1">
                                    <input
                                      type="checkbox"
                                      checked={editValues.parents.includes(p.trainingTitle)}
                                      onChange={(e) => {
                                        setEditValues((prev) => ({
                                          ...prev,
                                          parents: e.target.checked
                                            ? [...prev.parents, p.trainingTitle]
                                            : prev.parents.filter((x) => x !== p.trainingTitle),
                                        }));
                                      }}
                                      className="rounded border-gray-300"
                                    />
                                    <span className="text-xs">{p.fullTitle}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  }
                  if (isExpanded) {
                    for (const s of subs) {
                      rows.push(
                        <tr key={`${t.trainingTitle}::${s.trainingTitle}`} className="border-b border-gray-100 bg-gray-50/40">
                          <td className="pl-10 pr-4 py-2 text-sm text-gray-700">
                            <span className="text-xs text-gray-400 mr-2">↳</span>
                            {s.fullTitle}
                          </td>
                          <td className="px-4 py-2 text-sm text-gray-600">{s.trainingTitle}</td>
                          <td className="px-4 py-2 text-sm text-gray-600">{TRAINING_TYPE_LABELS[s.trainingType] || s.trainingType}</td>
                          <td className="px-4 py-2 text-sm">{s.link ? (
                            <a href={s.link} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Link</a>
                          ) : "-"}</td>
                          <td className="px-4 py-2 text-sm text-gray-600">{s.productType}</td>
                          <td className="px-4 py-2 text-sm text-gray-600">{FUNCTION_TYPE_LABELS[s.function] || s.function}</td>
                          <td className="px-4 py-2 text-sm text-gray-400">-</td>
                          <td className="px-4 py-2 text-sm">
                            <button
                              onClick={() => {
                                setEditingTitle(s.trainingTitle);
                                setEditValues({
                                  trainingTitle: s.trainingTitle,
                                  fullTitle: s.fullTitle,
                                  trainingType: s.trainingType,
                                  productType: s.productType,
                                  function: s.function,
                                  link: s.link || "",
                                  certification: s.certification || [],
                                  subItems: s.subItems || [],
                                  parents: s.parents || [],
                                  isLegacy: s.isLegacy ?? false,
                                  replacedBy: s.replacedBy || [],
                                });
                              }}
                              className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                            >
                              Edit
                            </button>
                          </td>
                        </tr>
                      );
                    }
                  }
                  return rows;
                }))}
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
        size="lg"
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
              onChange={(e) => {
                const val = e.target.value;
                setNewTraining((prev) => ({
                  ...prev,
                  trainingType: val,
                  certification: (val === "InstructorLedTraining" || val === "OLX") ? prev.certification : [],
                  subItems: val === "OLX" ? prev.subItems : [],
                  parents: val === "OLXSubItem" ? prev.parents : [],
                }));
              }}
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
              {productTypes.map((t) => (
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
          {(newTraining.trainingType === "InstructorLedTraining" || newTraining.trainingType === "OLX") && (
            <div>
              <label className="block text-sm font-medium mb-1">Certification</label>
              <div className="max-h-40 overflow-y-auto border border-gray-300 rounded-lg px-3 py-2 text-sm space-y-1">
                {certificationOptions.length === 0 && (
                  <span className="text-gray-400 text-xs">No certifications available</span>
                )}
                {certificationOptions.map((c) => (
                  <label key={c} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1">
                    <input
                      type="checkbox"
                      checked={newTraining.certification.includes(c)}
                      onChange={(e) => {
                        setNewTraining((prev) => ({
                          ...prev,
                          certification: e.target.checked
                            ? [...prev.certification, c]
                            : prev.certification.filter((x) => x !== c),
                        }));
                      }}
                      className="rounded border-gray-300"
                    />
                    <span>{c}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {(newTraining.trainingType === "Certification" || newTraining.trainingType === "Accreditation") && (
            <div className="rounded-lg border border-gray-200 p-3 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer text-sm font-medium">
                <input
                  type="checkbox"
                  checked={newTraining.isLegacy}
                  onChange={(e) =>
                    setNewTraining((prev) => ({
                      ...prev,
                      isLegacy: e.target.checked,
                      replacedBy: e.target.checked ? prev.replacedBy : [],
                    }))
                  }
                  className="rounded border-gray-300"
                />
                Mark as Legacy
              </label>
              {newTraining.isLegacy && (
                <div>
                  <label className="block text-sm font-medium mb-1">Replaced by <span className="text-xs text-gray-500">(optional — select one or more)</span></label>
                  <div className="max-h-40 overflow-y-auto border border-gray-300 rounded-lg px-3 py-2 text-sm space-y-1">
                    {replacementOptions.filter((r) => r.trainingTitle !== newTraining.trainingTitle).length === 0 && (
                      <span className="text-gray-400 text-xs">No certifications/accreditations available</span>
                    )}
                    {replacementOptions
                      .filter((r) => r.trainingTitle !== newTraining.trainingTitle)
                      .map((r) => (
                        <label key={r.trainingTitle} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1">
                          <input
                            type="checkbox"
                            checked={newTraining.replacedBy.includes(r.trainingTitle)}
                            onChange={(e) => {
                              setNewTraining((prev) => ({
                                ...prev,
                                replacedBy: e.target.checked
                                  ? [...prev.replacedBy, r.trainingTitle]
                                  : prev.replacedBy.filter((x) => x !== r.trainingTitle),
                              }));
                            }}
                            className="rounded border-gray-300"
                          />
                          <span>{r.fullTitle}</span>
                        </label>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {newTraining.trainingType === "OLX" && (
            <div>
              <label className="block text-sm font-medium mb-1">
                Sub-Items
                <span className="text-xs text-gray-500 ml-2">
                  (leave empty for a single-item OLX)
                </span>
              </label>
              <div className="max-h-40 overflow-y-auto border border-gray-300 rounded-lg px-3 py-2 text-sm space-y-1">
                {subItemOptions.length === 0 && (
                  <span className="text-gray-400 text-xs">
                    No OLX Sub-Item entries available. Create them first, then assign here.
                  </span>
                )}
                {subItemOptions.map((s) => (
                  <label key={s.trainingTitle} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1">
                    <input
                      type="checkbox"
                      checked={newTraining.subItems.includes(s.trainingTitle)}
                      onChange={(e) => {
                        setNewTraining((prev) => ({
                          ...prev,
                          subItems: e.target.checked
                            ? [...prev.subItems, s.trainingTitle]
                            : prev.subItems.filter((x) => x !== s.trainingTitle),
                        }));
                      }}
                      className="rounded border-gray-300"
                    />
                    <span>{s.fullTitle}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {newTraining.trainingType === "OLXSubItem" && (
            <div>
              <label className="block text-sm font-medium mb-1">
                Parent OLX
                <span className="text-xs text-gray-500 ml-2">
                  (one or more — sub-items can be shared across parents)
                </span>
              </label>
              <div className="max-h-40 overflow-y-auto border border-gray-300 rounded-lg px-3 py-2 text-sm space-y-1">
                {parentOptions.length === 0 && (
                  <span className="text-gray-400 text-xs">
                    No OLX parent entries available yet. You can leave this empty and assign later.
                  </span>
                )}
                {parentOptions.map((p) => (
                  <label key={p.trainingTitle} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1">
                    <input
                      type="checkbox"
                      checked={newTraining.parents.includes(p.trainingTitle)}
                      onChange={(e) => {
                        setNewTraining((prev) => ({
                          ...prev,
                          parents: e.target.checked
                            ? [...prev.parents, p.trainingTitle]
                            : prev.parents.filter((x) => x !== p.trainingTitle),
                        }));
                      }}
                      className="rounded border-gray-300"
                    />
                    <span>{p.fullTitle}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
