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
  Search,
  X,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";

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

  // Form
  const emptyForm = {
    programName: "",
    specialisationId: 0,
    level: "",
    trainingType: "",
    trainingTitle: "",
    quantityRequired: 1,
  };
  const [addForm, setAddForm] = useState(emptyForm);
  const [editForm, setEditForm] = useState<ProgramDataRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProgramDataRow | null>(null);
  const [formError, setFormError] = useState("");
  const [newSpecName, setNewSpecName] = useState("");
  const [addSpecError, setAddSpecError] = useState("");

  // Training options for dropdown
  const [trainingOptions, setTrainingOptions] = useState<TrainingOption[]>([]);

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

  useEffect(() => {
    fetchData();
    fetchSpecialisations();
  }, []);

  // Fetch trainings when type changes (for add form)
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
      const matchesSearch =
        !q ||
        row.programName.toLowerCase().includes(q) ||
        row.specialisationName.toLowerCase().includes(q) ||
        row.trainingFullTitle.toLowerCase().includes(q) ||
        row.level.toLowerCase().includes(q) ||
        (TRAINING_TYPE_LABELS[row.trainingType] || row.trainingType).toLowerCase().includes(q);
      const matchesProgram = !filterProgram || row.programName === filterProgram;
      const matchesSpec = !filterSpec || row.specialisationName === filterSpec;
      const matchesLevel = !filterLevel || row.level === filterLevel;
      const matchesType = !filterType || row.trainingType === filterType;
      return matchesSearch && matchesProgram && matchesSpec && matchesLevel && matchesType;
    });
  }, [data, debouncedSearch, filterProgram, filterSpec, filterLevel, filterType]);

  const sortedData = useMemo(() => {
    const sorted = [...filteredData];
    sorted.sort((a, b) => {
      let aVal = "", bVal = "";
      switch (sortCol) {
        case "programName": aVal = a.programName; bVal = b.programName; break;
        case "specialisationName": aVal = a.specialisationName; bVal = b.specialisationName; break;
        case "level": aVal = a.level; bVal = b.level; break;
        case "trainingType": aVal = a.trainingType; bVal = b.trainingType; break;
        case "trainingFullTitle": aVal = a.trainingFullTitle; bVal = b.trainingFullTitle; break;
        case "quantityRequired": return sortDir === "asc" ? a.quantityRequired - b.quantityRequired : b.quantityRequired - a.quantityRequired;
      }
      return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
    return sorted;
  }, [filteredData, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedData.length / pageSize));
  const pagedData = sortedData.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => { setPage(1); }, [debouncedSearch, filterProgram, filterSpec, filterLevel, filterType, pageSize]);

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
    const res = await fetch("/api/admin/program-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(addForm),
    });
    const result = await res.json();
    if (!res.ok) {
      setFormError(result.error);
      return;
    }
    setShowAdd(false);
    setAddForm(emptyForm);
    setTrainingOptions([]);
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
        trainingType: editForm.trainingType,
        trainingTitle: editForm.trainingTitle,
        quantityRequired: editForm.quantityRequired,
      }),
    });
    const result = await res.json();
    if (!res.ok) {
      setFormError(result.error);
      return;
    }
    setShowEdit(false);
    setEditForm(null);
    setTrainingOptions([]);
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
    // Auto-select the new specialisation
    setAddForm((f) => ({ ...f, specialisationId: result.id }));
  };

  const openEditModal = (row: ProgramDataRow) => {
    setEditForm({ ...row });
    setFormError("");
    fetchTrainingsByType(row.trainingType);
    setShowEdit(true);
  };

  // Export
  const exportColumns = [
    { key: "programName" as const, header: "Program Name" },
    { key: "specialisationName" as const, header: "Specialisation" },
    { key: "level" as const, header: "Level" },
    { key: "trainingType" as const, header: "Type" },
    { key: "trainingFullTitle" as const, header: "Training" },
    { key: "quantityRequired" as const, header: "Quantity Required" },
  ];

  const exportData = sortedData.map((r) => ({
    programName: r.programName,
    specialisationName: r.specialisationName,
    level: r.level,
    trainingType: TRAINING_TYPE_LABELS[r.trainingType] || r.trainingType,
    trainingFullTitle: r.trainingFullTitle,
    quantityRequired: r.quantityRequired,
  }));

  const hasFilters = !!searchQuery || !!filterProgram || !!filterSpec || !!filterLevel || !!filterType;

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
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                onClick={() => setShowExport((p) => !p)}
                className="flex items-center gap-1 px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                <Download size={16} /> Export
              </button>
              {showExport && (
                <div className="absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
                  <button
                    className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
                    onClick={() => { exportToCsv(exportData as never[], exportColumns as never[], "program-data"); setShowExport(false); }}
                  >
                    Export as CSV
                  </button>
                  <button
                    className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
                    onClick={() => { exportToExcel(exportData as never[], exportColumns as never[], "program-data"); setShowExport(false); }}
                  >
                    Export as Excel
                  </button>
                  <button
                    className="w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
                    onClick={() => { exportToPdf(exportData as never[], exportColumns as never[], "program-data"); setShowExport(false); }}
                  >
                    Export as PDF
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={() => { setShowAdd(true); setFormError(""); setAddForm(emptyForm); setTrainingOptions([]); }}
              className="flex items-center gap-1 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Plus size={16} /> Add Requirement
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg">{error}</div>
      )}

      {/* Search & Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-8 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <X size={16} />
              </button>
            )}
          </div>
          <select value={filterProgram} onChange={(e) => setFilterProgram(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm">
            <option value="">All Programs</option>
            {programNames.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={filterSpec} onChange={(e) => setFilterSpec(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm">
            <option value="">All Specialisations</option>
            {specNames.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filterLevel} onChange={(e) => setFilterLevel(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm">
            <option value="">All Levels</option>
            {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
          </select>
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm">
            <option value="">All Types</option>
            {TRAINING_TYPES.map((t) => <option key={t} value={t}>{TRAINING_TYPE_LABELS[t]}</option>)}
          </select>
          {hasFilters && (
            <button
              onClick={() => { setSearchQuery(""); setFilterProgram(""); setFilterSpec(""); setFilterLevel(""); setFilterType(""); }}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Data Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                {[
                  { key: "programName", label: "Program Name" },
                  { key: "specialisationName", label: "Specialisation" },
                  { key: "level", label: "Level" },
                  { key: "trainingType", label: "Type" },
                  { key: "trainingFullTitle", label: "Training" },
                  { key: "quantityRequired", label: "Qty Required" },
                ].map((col) => (
                  <th
                    key={col.key}
                    className="px-4 py-3 font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
                    onClick={() => toggleSort(col.key)}
                  >
                    <span className="flex items-center gap-1">
                      {col.label} <SortIcon col={col.key} />
                    </span>
                  </th>
                ))}
                <th className="px-4 py-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pagedData.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    {data.length === 0 ? "No program data yet. Click \"Add Requirement\" to get started." : "No results match your filters."}
                  </td>
                </tr>
              ) : (
                pagedData.map((row) => (
                  <tr key={row.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">{row.programName}</td>
                    <td className="px-4 py-3">{row.specialisationName}</td>
                    <td className="px-4 py-3">{LEVEL_LABELS[row.level] || row.level}</td>
                    <td className="px-4 py-3">{TRAINING_TYPE_LABELS[row.trainingType] || row.trainingType}</td>
                    <td className="px-4 py-3">{row.trainingFullTitle}</td>
                    <td className="px-4 py-3">{row.quantityRequired}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => openEditModal(row)}
                          className="text-blue-600 hover:text-blue-800 text-xs font-medium"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => { setDeleteTarget(row); setShowDelete(true); setFormError(""); }}
                          className="text-red-600 hover:text-red-800"
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
            <input
              type="text"
              value={addForm.programName}
              onChange={(e) => setAddForm((f) => ({ ...f, programName: e.target.value }))}
              placeholder="e.g., Authorized Professional Services (APS)"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            />
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
              onChange={(e) => setAddForm((f) => ({ ...f, level: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            >
              <option value="">Select level...</option>
              {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
            </select>
          </div>
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
              {addForm.level === "Global"
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
              <input
                type="text"
                value={editForm.programName}
                onChange={(e) => setEditForm((f) => f ? { ...f, programName: e.target.value } : f)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              />
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
                onChange={(e) => setEditForm((f) => f ? { ...f, level: e.target.value } : f)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              >
                {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Type</label>
              <select
                value={editForm.trainingType}
                onChange={(e) => {
                  const type = e.target.value;
                  setEditForm((f) => f ? { ...f, trainingType: type, trainingTitle: "" } : f);
                  fetchTrainingsByType(type);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              >
                {TRAINING_TYPES.map((t) => <option key={t} value={t}>{TRAINING_TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Training</label>
              <select
                value={editForm.trainingTitle}
                onChange={(e) => setEditForm((f) => f ? { ...f, trainingTitle: e.target.value } : f)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              >
                <option value="">Select training...</option>
                {trainingOptions.map((t) => <option key={t.trainingTitle} value={t.trainingTitle}>{t.fullTitle}</option>)}
              </select>
            </div>
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
                {editForm.level === "Global"
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
              Are you sure you want to delete the requirement for <strong>{deleteTarget.trainingFullTitle}</strong> under{" "}
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
              placeholder="e.g., Cortex XDR"
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
    </div>
  );
}
