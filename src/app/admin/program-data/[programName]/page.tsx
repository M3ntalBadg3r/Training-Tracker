"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import RequirementModal from "../RequirementModal";
import { ProgramDataRow, SpecialisationRow } from "@/types";
import { trainingTypeLabel } from "@/lib/utils";
import { Plus, Trash2, ChevronUp, ChevronDown } from "lucide-react";

const LEVELS = ["Country", "Theatre", "Global"];
const TRAINING_TYPES = ["Certification", "Accreditation", "InstructorLedTraining"];

const LEVEL_LABELS: Record<string, string> = {
  Country: "Country",
  Theatre: "Theatre",
  Global: "Global",
};

type SortDir = "asc" | "desc";

export default function ProgramRequirementsPage() {
  const params = useParams<{ programName: string }>();
  const programName = useMemo(() => {
    try {
      return decodeURIComponent(params.programName);
    } catch {
      return params.programName;
    }
  }, [params.programName]);

  const [rows, setRows] = useState<ProgramDataRow[]>([]);
  const [specialisations, setSpecialisations] = useState<SpecialisationRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [filterSpec, setFilterSpec] = useState("");
  const [filterLevel, setFilterLevel] = useState("");
  const [filterType, setFilterType] = useState("");

  // Sort
  const [sortCol, setSortCol] = useState("specialisationName");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Modals
  const [showRequirement, setShowRequirement] = useState(false);
  const [editTarget, setEditTarget] = useState<ProgramDataRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProgramDataRow | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const fetchData = async () => {
    try {
      const res = await fetch("/api/admin/program-data");
      if (res.ok) {
        const all: ProgramDataRow[] = await res.json();
        setRows(all.filter((r) => r.programName === programName));
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchSpecialisations = async () => {
    try {
      const res = await fetch("/api/admin/specialisations");
      if (res.ok) setSpecialisations(await res.json());
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetchData();
    fetchSpecialisations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programName]);

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

  // Distinct specialisations present in this program's requirements (for the filter).
  const specOptions = useMemo(
    () => [...new Set(rows.map((r) => r.specialisationName))].sort((a, b) => a.localeCompare(b)),
    [rows]
  );

  const filteredRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!filterSpec || r.specialisationName === filterSpec) &&
          (!filterLevel || r.level === filterLevel) &&
          (!filterType || r.trainingType === filterType)
      ),
    [rows, filterSpec, filterLevel, filterType]
  );

  const hasFilters = !!filterSpec || !!filterLevel || !!filterType;

  const sortedRows = useMemo(() => {
    const sorted = [...filteredRows];
    sorted.sort((a, b) => {
      let aVal = "", bVal = "";
      switch (sortCol) {
        case "specialisationName": aVal = a.specialisationName; bVal = b.specialisationName; break;
        case "level": aVal = a.level; bVal = b.level; break;
        case "trainingType": aVal = a.trainingType || ""; bVal = b.trainingType || ""; break;
        case "trainingFullTitle": aVal = a.trainingFullTitle || ""; bVal = b.trainingFullTitle || ""; break;
        case "quantityRequired": return sortDir === "asc" ? a.quantityRequired - b.quantityRequired : b.quantityRequired - a.quantityRequired;
      }
      return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
    return sorted;
  }, [filteredRows, sortCol, sortDir]);

  const openAdd = () => { setEditTarget(null); setShowRequirement(true); };
  const openEdit = (row: ProgramDataRow) => { setEditTarget(row); setShowRequirement(true); };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError("");
    const res = await fetch(`/api/admin/program-data/${deleteTarget.id}`, { method: "DELETE" });
    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      setDeleteError(result.error || "Failed to delete requirement");
      return;
    }
    setDeleteTarget(null);
    fetchData();
  };

  if (loading) {
    return (
      <div>
        <PageHeader title={programName} showBack helpSlug="admin-program-data" />
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={programName} showBack helpSlug="admin-program-data" />

      <section className="mb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={openAdd}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={16} /> Add Requirement
          </button>
          {hasFilters && (
            <button
              onClick={() => { setFilterSpec(""); setFilterLevel(""); setFilterType(""); }}
              className="text-sm text-blue-600 hover:text-blue-800 whitespace-nowrap"
            >
              Clear Filters
            </button>
          )}
        </div>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => toggleSort("specialisationName")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      Specialisation <SortIcon col="specialisationName" />
                    </button>
                    <select value={filterSpec} onChange={(e) => setFilterSpec(e.target.value)} className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal">
                      <option value="">All</option>
                      {specOptions.map((s) => <option key={s} value={s}>{s}</option>)}
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
                      {TRAINING_TYPES.map((t) => <option key={t} value={t}>{trainingTypeLabel(t)}</option>)}
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
              {sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    {rows.length === 0
                      ? <>No requirements yet for this program. Click &quot;Add Requirement&quot; to define the first one.</>
                      : "No requirements match the current filters."}
                  </td>
                </tr>
              ) : (
                sortedRows.map((row) => (
                  <tr key={row.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">{row.specialisationName}</td>
                    <td className="px-4 py-3">{LEVEL_LABELS[row.level] || row.level}</td>
                    <td className="px-4 py-3">{row.trainingType ? trainingTypeLabel(row.trainingType) : "—"}</td>
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
                          onClick={() => openEdit(row)}
                          className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => { setDeleteTarget(row); setDeleteError(""); }}
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
      </div>

      {/* Add / Edit Requirement */}
      <RequirementModal
        open={showRequirement}
        onClose={() => setShowRequirement(false)}
        programName={programName}
        specialisations={specialisations}
        initial={editTarget}
        onSaved={fetchData}
        onSpecialisationAdded={fetchSpecialisations}
      />

      {/* Delete Requirement */}
      <Modal open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="Delete Requirement">
        {deleteTarget && (
          <div>
            {deleteError && <div className="mb-3 p-2 bg-red-50 text-red-700 rounded text-sm">{deleteError}</div>}
            <p className="text-sm mb-4">
              Are you sure you want to delete the requirement for{" "}
              <strong>{deleteTarget.trainingFullTitle || "this global requirement"}</strong> under{" "}
              <strong>{deleteTarget.specialisationName}</strong>?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleDelete} className="flex items-center gap-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">
                <Trash2 size={16} /> Delete
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
