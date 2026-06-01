"use client";

import { useEffect, useState, useMemo } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { ProgramDataRow, SpecialisationRow } from "@/types";
import { useDebounce } from "@/hooks/useDebounce";
import {
  Plus,
  Trash2,
  Save,
  Download,
  Upload,
  Search,
  X,
  ChevronUp,
  ChevronDown,
  FileDown,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import Papa from "papaparse";
import * as XLSX from "xlsx";

const TRAINING_TYPES = ["Certification", "Accreditation", "InstructorLedTraining"];
const LEVELS = ["Country", "Theatre", "Global"];

const TRAINING_TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
  InstructorLedTraining: "Instructor-Led Training",
};

const LEVEL_LABELS: Record<string, string> = {
  Country: "Country",
  Theatre: "Theatre",
  Global: "Global",
};

interface TrainingOption {
  trainingTitle: string;
  fullTitle: string;
}

type SortDir = "asc" | "desc";

export default function ProgramDataPage() {
  const [data, setData] = useState<ProgramDataRow[]>([]);
  const [specialisations, setSpecialisations] = useState<SpecialisationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Search & filter
  const [searchQuery, setSearchQuery] = useState("");
  const [searchColumn, setSearchColumn] = useState("all");
  const debouncedSearch = useDebounce(searchQuery, 300);
  const [filterProgram, setFilterProgram] = useState("");
  const [filterSpec, setFilterSpec] = useState("");
  const [filterLevel, setFilterLevel] = useState("");
  const [filterType, setFilterType] = useState("");

  // Sort
  const [sortCol, setSortCol] = useState("programName");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Modals
  const [showAdd, setShowAdd] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showAddSpec, setShowAddSpec] = useState(false);
  const [showAddProgram, setShowAddProgram] = useState(false);

  // Import
  type ImportStep = "upload" | "preview" | "result";
  interface ImportRow {
    programName?: string;
    specialisationName?: string;
    level?: string;
    trainingType?: string;
    trainingFullTitle?: string;
    quantityRequired?: string | number;
    minimumPerTheatre?: string | number | null;
    alternatives?: string;
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

  // Form
  const emptyForm = {
    programName: "",
    specialisationId: 0,
    level: "",
    trainingType: "",
    trainingTitle: "",
    quantityRequired: 1,
    minimumPerTheatre: null as number | null,
  };
  const [addForm, setAddForm] = useState(emptyForm);
  const [addNoTraining, setAddNoTraining] = useState(false);
  const [editForm, setEditForm] = useState<ProgramDataRow | null>(null);
  const [editNoTraining, setEditNoTraining] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProgramDataRow | null>(null);
  const [formError, setFormError] = useState("");
  const [newSpecName, setNewSpecName] = useState("");
  const [addSpecError, setAddSpecError] = useState("");
  const [newProgramName, setNewProgramName] = useState("");
  const [addProgramError, setAddProgramError] = useState("");

  // Which form triggered the add-program modal
  const [addProgramContext, setAddProgramContext] = useState<"add" | "edit">("add");

  // Training options for dropdown
  const [trainingOptions, setTrainingOptions] = useState<TrainingOption[]>([]);

  // Alternatives state
  interface AlternativeEntry { trainingType: string; trainingTitle: string; trainingFullTitle: string }
  const [addAlternatives, setAddAlternatives] = useState<AlternativeEntry[]>([]);
  const [editAlternatives, setEditAlternatives] = useState<AlternativeEntry[]>([]);
  const [showAddAlts, setShowAddAlts] = useState(false);
  const [showEditAlts, setShowEditAlts] = useState(false);
  const [altTrainingOptions, setAltTrainingOptions] = useState<Record<string, TrainingOption[]>>({});

  const fetchAltTrainingsByType = async (key: string, type: string) => {
    if (!type) return;
    try {
      const res = await fetch(`/api/training-data/by-type?type=${type}`);
      if (res.ok) {
        const options = await res.json();
        setAltTrainingOptions((prev) => ({ ...prev, [key]: options }));
      }
    } catch { /* ignore */ }
  };

  const fetchData = async () => {
    try {
      const res = await fetch("/api/admin/program-data");
      if (res.ok) {
        const rows = await res.json();
        setData(rows);
      }
    } catch {
      setError("Failed to load program data");
    } finally {
      setLoading(false);
    }
  };

  const fetchSpecialisations = async () => {
    try {
      const res = await fetch("/api/admin/specialisations");
      if (res.ok) {
        setSpecialisations(await res.json());
      }
    } catch { /* ignore */ }
  };

  const [lastImport, setLastImport] = useState<string | null>(null);

  const fetchLastImport = () => {
    fetch("/api/import-metadata?key=program-data")
      .then((res) => res.json())
      .then((d) => { if (d?.timestamp) setLastImport(d.timestamp); })
      .catch(() => {});
  };

  useEffect(() => {
    fetchData();
    fetchSpecialisations();
    fetchLastImport();
  }, []);

  // Fetch trainings when type changes
  const fetchTrainingsByType = async (type: string) => {
    if (!type) {
      setTrainingOptions([]);
      return;
    }
    try {
      const res = await fetch(`/api/training-data/by-type?type=${type}`);
      if (res.ok) {
        setTrainingOptions(await res.json());
      }
    } catch { /* ignore */ }
  };

  // Unique values for filters
  const programNames = useMemo(() => [...new Set(data.map((d) => d.programName))].sort(), [data]);
  const specNames = useMemo(() => [...new Set(data.map((d) => d.specialisationName))].sort(), [data]);

  // Filtered & sorted data
  const filteredData = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    return data.filter((row) => {
      let matchesSearch = true;
      if (q) {
        if (searchColumn === "programName") {
          matchesSearch = row.programName.toLowerCase().includes(q);
        } else if (searchColumn === "specialisationName") {
          matchesSearch = row.specialisationName.toLowerCase().includes(q);
        } else if (searchColumn === "trainingFullTitle") {
          matchesSearch = (row.trainingFullTitle || "").toLowerCase().includes(q);
        } else if (searchColumn === "level") {
          matchesSearch = row.level.toLowerCase().includes(q);
        } else if (searchColumn === "trainingType") {
          matchesSearch = (TRAINING_TYPE_LABELS[row.trainingType || ""] || row.trainingType || "").toLowerCase().includes(q);
        } else {
          matchesSearch =
            row.programName.toLowerCase().includes(q) ||
            row.specialisationName.toLowerCase().includes(q) ||
            (row.trainingFullTitle || "").toLowerCase().includes(q) ||
            row.level.toLowerCase().includes(q) ||
            (row.trainingType ? (TRAINING_TYPE_LABELS[row.trainingType] || row.trainingType).toLowerCase().includes(q) : false);
        }
      }
      const matchesProgram = !filterProgram || row.programName === filterProgram;
      const matchesSpec = !filterSpec || row.specialisationName === filterSpec;
      const matchesLevel = !filterLevel || row.level === filterLevel;
      const matchesType = !filterType || row.trainingType === filterType;
      return matchesSearch && matchesProgram && matchesSpec && matchesLevel && matchesType;
    });
  }, [data, debouncedSearch, searchColumn, filterProgram, filterSpec, filterLevel, filterType]);

  const sortedData = useMemo(() => {
    const sorted = [...filteredData];
    sorted.sort((a, b) => {
      let aVal = "", bVal = "";
      switch (sortCol) {
        case "programName": aVal = a.programName; bVal = b.programName; break;
        case "specialisationName": aVal = a.specialisationName; bVal = b.specialisationName; break;
        case "level": aVal = a.level; bVal = b.level; break;
        case "trainingType": aVal = a.trainingType || ""; bVal = b.trainingType || ""; break;
        case "trainingFullTitle": aVal = a.trainingFullTitle || ""; bVal = b.trainingFullTitle || ""; break;
        case "quantityRequired": return sortDir === "asc" ? a.quantityRequired - b.quantityRequired : b.quantityRequired - a.quantityRequired;
      }
      return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
    return sorted;
  }, [filteredData, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedData.length / pageSize));
  const pagedData = sortedData.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => { setPage(1); }, [debouncedSearch, searchColumn, filterProgram, filterSpec, filterLevel, filterType, pageSize]);

  const toggleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ col }: { col: string }) =>
    sortCol === col ? (sortDir === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : null;

  // CRUD handlers
  const handleAdd = async () => {
    setFormError("");
    const payload = {
      ...addForm,
      trainingType: addNoTraining ? null : addForm.trainingType,
      trainingTitle: addNoTraining ? null : addForm.trainingTitle,
      minimumPerTheatre: addNoTraining ? null : (addForm.minimumPerTheatre ?? null),
      alternatives: showAddAlts ? addAlternatives.filter((a) => a.trainingTitle) : [],
    };
    const res = await fetch("/api/admin/program-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (!res.ok) {
      setFormError(result.error);
      return;
    }
    setShowAdd(false);
    setAddForm(emptyForm);
    setAddNoTraining(false);
    setAddAlternatives([]);
    setShowAddAlts(false);
    setTrainingOptions([]);
    setAltTrainingOptions({});
    fetchData();
  };

  const handleEdit = async () => {
    if (!editForm) return;
    setFormError("");
    const res = await fetch(`/api/admin/program-data/${editForm.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        programName: editForm.programName,
        specialisationId: editForm.specialisationId,
        level: editForm.level,
        trainingType: editNoTraining ? null : editForm.trainingType,
        trainingTitle: editNoTraining ? null : editForm.trainingTitle,
        quantityRequired: editForm.quantityRequired,
        minimumPerTheatre: editNoTraining ? null : (editForm.minimumPerTheatre ?? null),
        alternatives: showEditAlts ? editAlternatives.filter((a) => a.trainingTitle) : [],
      }),
    });
    const result = await res.json();
    if (!res.ok) {
      setFormError(result.error);
      return;
    }
    setShowEdit(false);
    setEditForm(null);
    setEditAlternatives([]);
    setShowEditAlts(false);
    setTrainingOptions([]);
    setAltTrainingOptions({});
    fetchData();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/admin/program-data/${deleteTarget.id}`, { method: "DELETE" });
    if (!res.ok) {
      const result = await res.json();
      setFormError(result.error);
      return;
    }
    setShowDelete(false);
    setDeleteTarget(null);
    fetchData();
  };

  const handleAddSpecialisation = async () => {
    setAddSpecError("");
    const res = await fetch("/api/admin/specialisations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newSpecName }),
    });
    const result = await res.json();
    if (!res.ok) {
      setAddSpecError(result.error);
      return;
    }
    setShowAddSpec(false);
    setNewSpecName("");
    fetchSpecialisations();
    setAddForm((f) => ({ ...f, specialisationId: result.id }));
  };

  const handleAddProgram = () => {
    setAddProgramError("");
    const trimmed = newProgramName.trim();
    if (!trimmed) { setAddProgramError("Program name is required"); return; }
    if (programNames.includes(trimmed)) { setAddProgramError("A program with this name already exists"); return; }
    if (addProgramContext === "add") {
      setAddForm((f) => ({ ...f, programName: trimmed }));
    } else {
      setEditForm((f) => f ? { ...f, programName: trimmed } : f);
    }
    setShowAddProgram(false);
    setNewProgramName("");
  };

  const openEditModal = (row: ProgramDataRow) => {
    setEditForm({ ...row });
    setEditNoTraining(row.level === "Global" && row.trainingTitle === null);
    setFormError("");
    if (row.trainingType) fetchTrainingsByType(row.trainingType);
    // Populate alternatives
    const alts = row.alternatives || [];
    setEditAlternatives(alts.map((a) => ({ ...a })));
    setShowEditAlts(alts.length > 0);
    // Pre-fetch training options for each alternative's type
    const newAltOptions: Record<string, TrainingOption[]> = {};
    setAltTrainingOptions(newAltOptions);
    alts.forEach((a, i) => {
      if (a.trainingType) fetchAltTrainingsByType(`edit-${i}`, a.trainingType);
    });
    setShowEdit(true);
  };

  // Export
  const exportColumns = [
    { key: "programName" as const, header: "Program Name" },
    { key: "specialisationName" as const, header: "Specialisation" },
    { key: "level" as const, header: "Level" },
    { key: "trainingType" as const, header: "Training Type" },
    { key: "trainingFullTitle" as const, header: "Training" },
    { key: "quantityRequired" as const, header: "Quantity Required" },
    { key: "minimumPerTheatre" as const, header: "Min per Theatre" },
    { key: "alternatives" as const, header: "Alternatives" },
  ];

  const exportData = sortedData.map((r) => {
    const altsLabel = r.alternatives && r.alternatives.length > 0
      ? r.alternatives.map((a) => a.trainingFullTitle).join("|")
      : "";
    return {
      programName: r.programName,
      specialisationName: r.specialisationName,
      level: r.level,
      trainingType: r.trainingType ? (TRAINING_TYPE_LABELS[r.trainingType] || r.trainingType) : "—",
      trainingFullTitle: r.trainingFullTitle || "—",
      quantityRequired: r.quantityRequired,
      minimumPerTheatre: r.minimumPerTheatre ?? "—",
      alternatives: altsLabel,
    };
  });

  const hasFilters = !!searchQuery || searchColumn !== "all" || !!filterProgram || !!filterSpec || !!filterLevel || !!filterType;

  // --- Import helpers ---
  const IMPORT_COLUMN_MAP: Record<string, keyof ImportRow> = {
    programname: "programName",
    program: "programName",
    specialisation: "specialisationName",
    specialization: "specialisationName",
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
      fetchData();
      fetchSpecialisations();
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
        "Level": "Global",
        "Training Type": "Certification",
        "Training": "Example Certification",
        "Quantity Required": 30,
        "Minimum per Theatre": 6,
        "Alternatives": "",
      },
      {
        "Program Name": "Example Program",
        "Specialisation": "Example Specialisation",
        "Level": "Country",
        "Training Type": "Certification",
        "Training": "Example Certification",
        "Quantity Required": 2,
        "Minimum per Theatre": "",
        "Alternatives": "Alternative Training A|Alternative Training B",
      },
    ];
    const templateCols = [
      { key: "Program Name", header: "Program Name" },
      { key: "Specialisation", header: "Specialisation" },
      { key: "Level", header: "Level" },
      { key: "Training Type", header: "Training Type" },
      { key: "Training", header: "Training" },
      { key: "Quantity Required", header: "Quantity Required" },
      { key: "Minimum per Theatre", header: "Minimum per Theatre" },
      { key: "Alternatives", header: "Alternatives" },
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

      {/* Import / Export / Add buttons */}
      <section className="mb-4">
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
            onClick={() => { setShowAdd(true); setFormError(""); setAddForm(emptyForm); setAddNoTraining(false); setTrainingOptions([]); setAddAlternatives([]); setShowAddAlts(false); setAltTrainingOptions({}); }}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={16} /> Add Requirement
          </button>
        </div>
      </section>

      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg">{error}</div>
      )}

      {/* Search bar */}
      <section className="mb-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <select
          value={searchColumn}
          onChange={(e) => setSearchColumn(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All columns</option>
          <option value="programName">Program</option>
          <option value="specialisationName">Specialisation</option>
          <option value="level">Level</option>
          <option value="trainingType">Training Type</option>
          <option value="trainingFullTitle">Training</option>
        </select>
        {hasFilters && (
          <button
            onClick={() => { setSearchQuery(""); setSearchColumn("all"); setFilterProgram(""); setFilterSpec(""); setFilterLevel(""); setFilterType(""); }}
            className="text-sm text-blue-600 hover:text-blue-800 whitespace-nowrap"
          >
            Clear Filters
          </button>
        )}
      </section>

      {/* Data Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => toggleSort("programName")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      Program Name <SortIcon col="programName" />
                    </button>
                    <select value={filterProgram} onChange={(e) => setFilterProgram(e.target.value)} className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal">
                      <option value="">All</option>
                      {programNames.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                </th>
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => toggleSort("specialisationName")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      Specialisation <SortIcon col="specialisationName" />
                    </button>
                    <select value={filterSpec} onChange={(e) => setFilterSpec(e.target.value)} className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal">
                      <option value="">All</option>
                      {specNames.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </th>
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => toggleSort("level")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      Level <SortIcon col="level" />
                    </button>
                    <select value={filterLevel} onChange={(e) => setFilterLevel(e.target.value)} className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal">
                      <option value="">All</option>
                      {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
                    </select>
                  </div>
                </th>
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => toggleSort("trainingType")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      Type <SortIcon col="trainingType" />
                    </button>
                    <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal">
                      <option value="">All</option>
                      {TRAINING_TYPES.map((t) => <option key={t} value={t}>{TRAINING_TYPE_LABELS[t]}</option>)}
                    </select>
                  </div>
                </th>
                <th className="px-4 py-3 text-left">
                  <button onClick={() => toggleSort("trainingFullTitle")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                    Training <SortIcon col="trainingFullTitle" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left">
                  <button onClick={() => toggleSort("quantityRequired")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                    Qty Required <SortIcon col="quantityRequired" />
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold text-gray-700">Min/Theatre</th>
                <th className="px-4 py-3 font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pagedData.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    {data.length === 0 ? "No program data yet. Click \"Add Requirement\" to get started." : "No results match your filters."}
                  </td>
                </tr>
              ) : (
                pagedData.map((row) => (
                  <tr key={row.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">{row.programName}</td>
                    <td className="px-4 py-3">{row.specialisationName}</td>
                    <td className="px-4 py-3">{LEVEL_LABELS[row.level] || row.level}</td>
                    <td className="px-4 py-3">{row.trainingType ? (TRAINING_TYPE_LABELS[row.trainingType] || row.trainingType) : "—"}</td>
                    <td className="px-4 py-3">
                      {row.trainingFullTitle || "—"}
                      {row.alternatives && row.alternatives.length > 0 && (
                        <div className="text-xs text-gray-500 mt-0.5">
                          or {row.alternatives.map((a) => a.trainingFullTitle).join(", ")}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">{row.quantityRequired}</td>
                    <td className="px-4 py-3">{row.minimumPerTheatre ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => openEditModal(row)}
                          className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => { setDeleteTarget(row); setShowDelete(true); setFormError(""); }}
                          className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {sortedData.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span>Showing {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, sortedData.length)} of {sortedData.length}</span>
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="ml-2 px-2 py-1 border border-gray-300 rounded bg-white text-sm">
                {[10, 25, 50, 100].map((s) => <option key={s} value={s}>{s} per page</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1 text-sm border rounded disabled:opacity-50 hover:bg-gray-50 border-gray-300">Prev</button>
              <span className="px-3 py-1 text-sm">{page} / {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 text-sm border rounded disabled:opacity-50 hover:bg-gray-50 border-gray-300">Next</button>
            </div>
          </div>
        )}
      </div>

      {/* Add Modal */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Program Requirement">
        <div className="space-y-4">
          {formError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{formError}</div>}
          <div>
            <label className="block text-sm font-medium mb-1">Program Name</label>
            <div className="flex gap-2">
              <select
                value={addForm.programName}
                onChange={(e) => setAddForm((f) => ({ ...f, programName: e.target.value }))}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              >
                <option value="">Select program...</option>
                {programNames.map((p) => <option key={p} value={p}>{p}</option>)}
                {addForm.programName && !programNames.includes(addForm.programName) && (
                  <option value={addForm.programName}>{addForm.programName}</option>
                )}
              </select>
              <button
                onClick={() => { setAddProgramContext("add"); setShowAddProgram(true); setAddProgramError(""); setNewProgramName(""); }}
                className="px-3 py-2 text-sm bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200"
                title="Add new program"
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Specialisation</label>
            <div className="flex gap-2">
              <select
                value={addForm.specialisationId}
                onChange={(e) => setAddForm((f) => ({ ...f, specialisationId: Number(e.target.value) }))}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              >
                <option value={0}>Select specialisation...</option>
                {specialisations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button
                onClick={() => { setShowAddSpec(true); setAddSpecError(""); setNewSpecName(""); }}
                className="px-3 py-2 text-sm bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200"
                title="Add new specialisation"
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Level</label>
            <select
              value={addForm.level}
              onChange={(e) => {
                const lvl = e.target.value;
                setAddForm((f) => ({ ...f, level: lvl }));
                setAddNoTraining(false);
                if (lvl !== "Global") fetchTrainingsByType(addForm.trainingType);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            >
              <option value="">Select level...</option>
              {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
            </select>
          </div>
          {addForm.level === "Global" && (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="add-no-training"
                checked={addNoTraining}
                onChange={(e) => {
                  setAddNoTraining(e.target.checked);
                  if (e.target.checked) setTrainingOptions([]);
                }}
                className="w-4 h-4"
              />
              <label htmlFor="add-no-training" className="text-sm">
                No specific training (count compliant theatres)
              </label>
            </div>
          )}
          {(addForm.level !== "Global" || !addNoTraining) && (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">Type</label>
                <select
                  value={addForm.trainingType}
                  onChange={(e) => {
                    const type = e.target.value;
                    setAddForm((f) => ({ ...f, trainingType: type, trainingTitle: "" }));
                    fetchTrainingsByType(type);
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                >
                  <option value="">Select type...</option>
                  {TRAINING_TYPES.map((t) => <option key={t} value={t}>{TRAINING_TYPE_LABELS[t]}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Training</label>
                <select
                  value={addForm.trainingTitle}
                  onChange={(e) => setAddForm((f) => ({ ...f, trainingTitle: e.target.value }))}
                  disabled={!addForm.trainingType}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm disabled:opacity-50"
                >
                  <option value="">{addForm.trainingType ? "Select training..." : "Select a type first..."}</option>
                  {trainingOptions.map((t) => <option key={t.trainingTitle} value={t.trainingTitle}>{t.fullTitle}</option>)}
                </select>
              </div>
              {addForm.level === "Global" && (
                <div>
                  <label className="block text-sm font-medium mb-1">Minimum per Theatre (optional)</label>
                  <input
                    type="number"
                    min={0}
                    value={addForm.minimumPerTheatre ?? ""}
                    onChange={(e) => setAddForm((f) => ({ ...f, minimumPerTheatre: e.target.value ? parseInt(e.target.value) : null }))}
                    placeholder="Leave blank if no per-theatre minimum"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                  />
                  <p className="mt-1 text-xs text-gray-500">Leave blank if no per-theatre minimum applies.</p>
                </div>
              )}
              {/* Accept alternative trainings */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="add-alts"
                  checked={showAddAlts}
                  onChange={(e) => {
                    setShowAddAlts(e.target.checked);
                    if (!e.target.checked) { setAddAlternatives([]); setAltTrainingOptions({}); }
                  }}
                  className="w-4 h-4"
                />
                <label htmlFor="add-alts" className="text-sm">
                  Accept alternative trainings
                </label>
              </div>
              {showAddAlts && (
                <div className="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50">
                  <p className="text-xs text-gray-500">Students with any of these alternative trainings will also count toward the requirement.</p>
                  {addAlternatives.map((alt, idx) => (
                    <div key={idx} className="flex items-end gap-2">
                      <div className="flex-1">
                        <label className="block text-xs font-medium mb-1 text-gray-600">Type</label>
                        <select
                          value={alt.trainingType}
                          onChange={(e) => {
                            const type = e.target.value;
                            setAddAlternatives((prev) => prev.map((a, i) => i === idx ? { ...a, trainingType: type, trainingTitle: "", trainingFullTitle: "" } : a));
                            fetchAltTrainingsByType(`add-${idx}`, type);
                          }}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded bg-white text-sm"
                        >
                          <option value="">Select type...</option>
                          {TRAINING_TYPES.map((t) => <option key={t} value={t}>{TRAINING_TYPE_LABELS[t]}</option>)}
                        </select>
                      </div>
                      <div className="flex-[2]">
                        <label className="block text-xs font-medium mb-1 text-gray-600">Training</label>
                        <select
                          value={alt.trainingTitle}
                          onChange={(e) => {
                            const title = e.target.value;
                            const opt = (altTrainingOptions[`add-${idx}`] || []).find((o) => o.trainingTitle === title);
                            setAddAlternatives((prev) => prev.map((a, i) => i === idx ? { ...a, trainingTitle: title, trainingFullTitle: opt?.fullTitle ?? "" } : a));
                          }}
                          disabled={!alt.trainingType}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded bg-white text-sm disabled:opacity-50"
                        >
                          <option value="">{alt.trainingType ? "Select training..." : "Select type first..."}</option>
                          {(altTrainingOptions[`add-${idx}`] || []).map((t) => <option key={t.trainingTitle} value={t.trainingTitle}>{t.fullTitle}</option>)}
                        </select>
                      </div>
                      <button
                        onClick={() => setAddAlternatives((prev) => prev.filter((_, i) => i !== idx))}
                        className="px-2 py-1.5 text-red-600 hover:bg-red-50 rounded"
                        title="Remove alternative"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setAddAlternatives((prev) => [...prev, { trainingType: "", trainingTitle: "", trainingFullTitle: "" }])}
                    className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
                  >
                    <Plus size={14} /> Add Alternative
                  </button>
                </div>
              )}
            </>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">Quantity Required</label>
            <input
              type="number"
              min={1}
              value={addForm.quantityRequired}
              onChange={(e) => setAddForm((f) => ({ ...f, quantityRequired: parseInt(e.target.value) || 1 }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">
              {addForm.level === "Global" && addNoTraining
                ? "Number of compliant theatres needed."
                : "Number of people with this training needed."}
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={handleAdd} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <Save size={16} /> Save
            </button>
          </div>
        </div>
      </Modal>

      {/* Edit Modal */}
      <Modal open={showEdit} onClose={() => setShowEdit(false)} title="Edit Program Requirement">
        {editForm && (
          <div className="space-y-4">
            {formError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{formError}</div>}
            <div>
              <label className="block text-sm font-medium mb-1">Program Name</label>
              <div className="flex gap-2">
                <select
                  value={editForm.programName}
                  onChange={(e) => setEditForm((f) => f ? { ...f, programName: e.target.value } : f)}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                >
                  <option value="">Select program...</option>
                  {programNames.map((p) => <option key={p} value={p}>{p}</option>)}
                  {/* Include current value even if not in programNames (shouldn't happen, but safe) */}
                  {editForm.programName && !programNames.includes(editForm.programName) && (
                    <option value={editForm.programName}>{editForm.programName}</option>
                  )}
                </select>
                <button
                  onClick={() => { setAddProgramContext("edit"); setShowAddProgram(true); setAddProgramError(""); setNewProgramName(""); }}
                  className="px-3 py-2 text-sm bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200"
                  title="Add new program"
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Specialisation</label>
              <select
                value={editForm.specialisationId}
                onChange={(e) => setEditForm((f) => f ? { ...f, specialisationId: Number(e.target.value) } : f)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              >
                <option value={0}>Select specialisation...</option>
                {specialisations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Level</label>
              <select
                value={editForm.level}
                onChange={(e) => {
                  const lvl = e.target.value;
                  setEditForm((f) => f ? { ...f, level: lvl } : f);
                  setEditNoTraining(false);
                  if (lvl !== "Global") fetchTrainingsByType(editForm.trainingType || "");
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              >
                {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
              </select>
            </div>
            {editForm.level === "Global" && (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="edit-no-training"
                  checked={editNoTraining}
                  onChange={(e) => {
                    setEditNoTraining(e.target.checked);
                    if (e.target.checked) setTrainingOptions([]);
                  }}
                  className="w-4 h-4"
                />
                <label htmlFor="edit-no-training" className="text-sm">
                  No specific training (count compliant theatres)
                </label>
              </div>
            )}
            {(editForm.level !== "Global" || !editNoTraining) && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-1">Type</label>
                  <select
                    value={editForm.trainingType || ""}
                    onChange={(e) => {
                      const type = e.target.value;
                      setEditForm((f) => f ? { ...f, trainingType: type, trainingTitle: null } : f);
                      fetchTrainingsByType(type);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                  >
                    <option value="">Select type...</option>
                    {TRAINING_TYPES.map((t) => <option key={t} value={t}>{TRAINING_TYPE_LABELS[t]}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Training</label>
                  <select
                    value={editForm.trainingTitle || ""}
                    onChange={(e) => setEditForm((f) => f ? { ...f, trainingTitle: e.target.value } : f)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                  >
                    <option value="">Select training...</option>
                    {trainingOptions.map((t) => <option key={t.trainingTitle} value={t.trainingTitle}>{t.fullTitle}</option>)}
                  </select>
                </div>
                {editForm.level === "Global" && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Minimum per Theatre (optional)</label>
                    <input
                      type="number"
                      min={0}
                      value={editForm.minimumPerTheatre ?? ""}
                      onChange={(e) => setEditForm((f) => f ? { ...f, minimumPerTheatre: e.target.value ? parseInt(e.target.value) : null } : f)}
                      placeholder="Leave blank if no per-theatre minimum"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                    />
                    <p className="mt-1 text-xs text-gray-500">Leave blank if no per-theatre minimum applies.</p>
                  </div>
                )}
                {/* Accept alternative trainings */}
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="edit-alts"
                    checked={showEditAlts}
                    onChange={(e) => {
                      setShowEditAlts(e.target.checked);
                      if (!e.target.checked) { setEditAlternatives([]); setAltTrainingOptions({}); }
                    }}
                    className="w-4 h-4"
                  />
                  <label htmlFor="edit-alts" className="text-sm">
                    Accept alternative trainings
                  </label>
                </div>
                {showEditAlts && (
                  <div className="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50">
                    <p className="text-xs text-gray-500">Students with any of these alternative trainings will also count toward the requirement.</p>
                    {editAlternatives.map((alt, idx) => (
                      <div key={idx} className="flex items-end gap-2">
                        <div className="flex-1">
                          <label className="block text-xs font-medium mb-1 text-gray-600">Type</label>
                          <select
                            value={alt.trainingType}
                            onChange={(e) => {
                              const type = e.target.value;
                              setEditAlternatives((prev) => prev.map((a, i) => i === idx ? { ...a, trainingType: type, trainingTitle: "", trainingFullTitle: "" } : a));
                              fetchAltTrainingsByType(`edit-${idx}`, type);
                            }}
                            className="w-full px-2 py-1.5 border border-gray-300 rounded bg-white text-sm"
                          >
                            <option value="">Select type...</option>
                            {TRAINING_TYPES.map((t) => <option key={t} value={t}>{TRAINING_TYPE_LABELS[t]}</option>)}
                          </select>
                        </div>
                        <div className="flex-[2]">
                          <label className="block text-xs font-medium mb-1 text-gray-600">Training</label>
                          <select
                            value={alt.trainingTitle}
                            onChange={(e) => {
                              const title = e.target.value;
                              const opt = (altTrainingOptions[`edit-${idx}`] || []).find((o) => o.trainingTitle === title);
                              setEditAlternatives((prev) => prev.map((a, i) => i === idx ? { ...a, trainingTitle: title, trainingFullTitle: opt?.fullTitle ?? "" } : a));
                            }}
                            disabled={!alt.trainingType}
                            className="w-full px-2 py-1.5 border border-gray-300 rounded bg-white text-sm disabled:opacity-50"
                          >
                            <option value="">{alt.trainingType ? "Select training..." : "Select type first..."}</option>
                            {(altTrainingOptions[`edit-${idx}`] || []).map((t) => <option key={t.trainingTitle} value={t.trainingTitle}>{t.fullTitle}</option>)}
                          </select>
                        </div>
                        <button
                          onClick={() => setEditAlternatives((prev) => prev.filter((_, i) => i !== idx))}
                          className="px-2 py-1.5 text-red-600 hover:bg-red-50 rounded"
                          title="Remove alternative"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => setEditAlternatives((prev) => [...prev, { trainingType: "", trainingTitle: "", trainingFullTitle: "" }])}
                      className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
                    >
                      <Plus size={14} /> Add Alternative
                    </button>
                  </div>
                )}
              </>
            )}
            <div>
              <label className="block text-sm font-medium mb-1">Quantity Required</label>
              <input
                type="number"
                min={1}
                value={editForm.quantityRequired}
                onChange={(e) => setEditForm((f) => f ? { ...f, quantityRequired: parseInt(e.target.value) || 1 } : f)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              />
              <p className="mt-1 text-xs text-gray-500">
                {editForm.level === "Global" && editNoTraining
                  ? "Number of compliant theatres needed."
                  : "Number of people with this training needed."}
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowEdit(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleEdit} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                <Save size={16} /> Save
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Modal */}
      <Modal open={showDelete} onClose={() => setShowDelete(false)} title="Delete Requirement">
        {deleteTarget && (
          <div>
            {formError && <div className="mb-3 p-2 bg-red-50 text-red-700 rounded text-sm">{formError}</div>}
            <p className="text-sm mb-4">
              Are you sure you want to delete the requirement for{" "}
              <strong>{deleteTarget.trainingFullTitle || "this global requirement"}</strong> under{" "}
              <strong>{deleteTarget.specialisationName}</strong> in the <strong>{deleteTarget.programName}</strong> program?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDelete(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleDelete} className="flex items-center gap-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">
                <Trash2 size={16} /> Delete
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Add Specialisation Modal */}
      <Modal open={showAddSpec} onClose={() => setShowAddSpec(false)} title="Add Specialisation">
        <div className="space-y-4">
          {addSpecError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{addSpecError}</div>}
          <div>
            <label className="block text-sm font-medium mb-1">Specialisation Name</label>
            <input
              type="text"
              value={newSpecName}
              onChange={(e) => setNewSpecName(e.target.value)}
              placeholder="e.g., a product or solution area"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setShowAddSpec(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={handleAddSpecialisation} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <Save size={16} /> Save
            </button>
          </div>
        </div>
      </Modal>

      {/* Add Program Modal */}
      <Modal open={showAddProgram} onClose={() => setShowAddProgram(false)} title="Add Program">
        <div className="space-y-4">
          {addProgramError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{addProgramError}</div>}
          <div>
            <label className="block text-sm font-medium mb-1">Program Name</label>
            <input
              type="text"
              value={newProgramName}
              onChange={(e) => setNewProgramName(e.target.value)}
              placeholder="e.g., Partner Compliance Program"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setShowAddProgram(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={handleAddProgram} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <Save size={16} /> Add
            </button>
          </div>
        </div>
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
              <p><strong>Expected columns:</strong> Program Name, Specialisation, Level, Training Type, Training, Quantity Required, Minimum per Theatre</p>
              <p>Training Type and Training are optional for Global-level rows with no specific training (these count compliant theatres).</p>
              <p>Specialisations are auto-created if they don&apos;t already exist.</p>
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

            {/* Preview table */}
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

            {/* Validation errors */}
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
                disabled={importLoading || (importValidated && importValidationErrors.length > 0)}
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
