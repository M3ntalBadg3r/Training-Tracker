"use client";

import { useEffect, useMemo, useState, use } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import DataTable from "@/components/data-table/DataTable";
import Badge from "@/components/ui/Badge";
import Modal from "@/components/ui/Modal";
import {
  ColumnDef,
  StudentRecord,
  StudentTrainingRow,
  TrainingDataRow,
} from "@/types";
import {
  Pencil,
  Save,
  X,
  Award,
  ShieldCheck,
  GraduationCap,
  Plus,
  Trash2,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { trainingTypeLabel, formatDate } from "@/lib/utils";

interface PendingAdd {
  tempId: number;
  trainingTitle: string;
  fullTitle: string;
  trainingType: string;
  productType: string;
  function: string;
  completedDate: string; // ISO yyyy-mm-dd from <input type="date">
}

const trainingColumns: ColumnDef<StudentTrainingRow>[] = [
  {
    key: "fullTitle",
    header: "Title",
    render: (row) =>
      row.link ? (
        <a
          href={row.link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline"
        >
          {row.fullTitle}
        </a>
      ) : (
        <span>{row.fullTitle}</span>
      ),
  },
  { key: "trainingType", header: "Type" },
  { key: "productType", header: "Product" },
  { key: "function", header: "Function" },
  { key: "completedDate", header: "Date Completed" },
  {
    key: "active",
    header: "Active",
    render: (row) => <Badge active={row.active} />,
    accessor: (row) => (row.active ? "Yes" : "No"),
  },
];

function toIsoDate(formatted: string): string {
  const d = new Date(formatted);
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function StudentRecordPage({
  params,
}: {
  params: Promise<{ email: string }>;
}) {
  const resolvedParams = use(params);
  const email = decodeURIComponent(resolvedParams.email);
  const { isAdmin } = useAuth();
  const router = useRouter();

  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    fullName: "",
    email: "",
    theatre: "",
    country: "",
  });

  // Pending training mutations (applied on Save)
  const [deletedTrainingIds, setDeletedTrainingIds] = useState<number[]>([]);
  const [pendingAdds, setPendingAdds] = useState<PendingAdd[]>([]);
  const [pendingEdits, setPendingEdits] = useState<Record<number, string>>({});

  // Catalog for the Add Training picker
  const [trainingCatalog, setTrainingCatalog] = useState<TrainingDataRow[]>([]);

  // Modals
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [showAddTraining, setShowAddTraining] = useState(false);
  const [showDeleteStudent, setShowDeleteStudent] = useState(false);
  const [editingTraining, setEditingTraining] = useState<{
    id: number;
    fullTitle: string;
    completedDate: string; // ISO yyyy-mm-dd
  } | null>(null);

  const [addTrainingForm, setAddTrainingForm] = useState({
    fullTitle: "",
    trainingTitle: "",
    completedDate: "",
  });
  const [addTrainingError, setAddTrainingError] = useState("");
  const [editTrainingError, setEditTrainingError] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [deleteStudentError, setDeleteStudentError] = useState("");

  useEffect(() => {
    fetch(`/api/students/${encodeURIComponent(email)}`)
      .then((res) => res.json())
      .then((data) => {
        setStudent(data);
        setEditForm({
          fullName: data.fullName,
          email: data.email,
          theatre: data.theatre,
          country: data.country,
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [email]);

  // Load training catalog the first time the user enters edit mode
  useEffect(() => {
    if (editing && trainingCatalog.length === 0) {
      fetch("/api/training-data/all")
        .then((res) => res.json())
        .then((data: TrainingDataRow[]) => setTrainingCatalog(data))
        .catch(() => {});
    }
  }, [editing, trainingCatalog.length]);

  const fullTitleOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { fullTitle: string; trainingType: string }[] = [];
    for (const t of trainingCatalog) {
      const key = `${t.fullTitle}::${t.trainingType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ fullTitle: t.fullTitle, trainingType: t.trainingType });
    }
    options.sort((a, b) => a.fullTitle.localeCompare(b.fullTitle));
    return options;
  }, [trainingCatalog]);

  const trainingTitleMatches = useMemo(() => {
    if (!addTrainingForm.fullTitle) return [];
    return trainingCatalog.filter(
      (t) => t.fullTitle === addTrainingForm.fullTitle
    );
  }, [trainingCatalog, addTrainingForm.fullTitle]);

  const handleSave = async () => {
    if (!student) return;
    setSaving(true);
    setSaveError("");

    try {
      // 1. Update student fields (and optionally email)
      const studentRes = await fetch(
        `/api/students/${encodeURIComponent(student.email)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fullName: editForm.fullName,
            newEmail:
              editForm.email !== student.email ? editForm.email : undefined,
            theatre: editForm.theatre,
            country: editForm.country,
          }),
        }
      );
      if (!studentRes.ok) {
        const data = await studentRes.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update student");
      }

      const targetEmail = editForm.email || student.email;

      // 2. Process deletes
      for (const id of deletedTrainingIds) {
        const r = await fetch(`/api/training-taken/${id}`, { method: "DELETE" });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `Failed to delete training ${id}`);
        }
      }

      // 3. Process edits
      for (const [idStr, completedDate] of Object.entries(pendingEdits)) {
        const id = Number(idStr);
        if (deletedTrainingIds.includes(id)) continue;
        const r = await fetch(`/api/training-taken/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completedDate }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `Failed to update training ${id}`);
        }
      }

      // 4. Process adds
      for (const add of pendingAdds) {
        const r = await fetch(`/api/training-taken`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: targetEmail,
            trainingTitle: add.trainingTitle,
            completedDate: add.completedDate,
          }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `Failed to add ${add.fullTitle}`);
        }
      }

      // 5. Reload data
      const res = await fetch(
        `/api/students/${encodeURIComponent(targetEmail)}`
      );
      const data = await res.json();
      setStudent(data);
      setEditForm({
        fullName: data.fullName,
        email: data.email,
        theatre: data.theatre,
        country: data.country,
      });
      setDeletedTrainingIds([]);
      setPendingAdds([]);
      setPendingEdits({});
      setEditing(false);
      setShowSaveConfirm(false);

      if (editForm.email !== student.email) {
        window.history.replaceState(
          null,
          "",
          `/students/${encodeURIComponent(targetEmail)}`
        );
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    if (student) {
      setEditForm({
        fullName: student.fullName,
        email: student.email,
        theatre: student.theatre,
        country: student.country,
      });
    }
    setDeletedTrainingIds([]);
    setPendingAdds([]);
    setPendingEdits({});
    setEditing(false);
    setSaveError("");
  };

  const handleDeleteTraining = (row: StudentTrainingRow) => {
    if (row.id < 0) {
      // Cancel a pending add
      setPendingAdds((prev) => prev.filter((p) => p.tempId !== row.id));
      return;
    }
    setDeletedTrainingIds((prev) =>
      prev.includes(row.id) ? prev : [...prev, row.id]
    );
    setPendingEdits((prev) => {
      if (!(row.id in prev)) return prev;
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
  };

  const handleEditTrainingClick = (row: StudentTrainingRow) => {
    if (row.id < 0) {
      // Edit a pending add: open the add modal pre-filled to update the queue
      const add = pendingAdds.find((p) => p.tempId === row.id);
      if (!add) return;
      setEditingTraining({
        id: row.id,
        fullTitle: add.fullTitle,
        completedDate: add.completedDate,
      });
    } else {
      setEditingTraining({
        id: row.id,
        fullTitle: row.fullTitle,
        completedDate: pendingEdits[row.id] ?? toIsoDate(row.completedDate),
      });
    }
    setEditTrainingError("");
  };

  const handleSaveEditTraining = () => {
    if (!editingTraining) return;
    if (!editingTraining.completedDate) {
      setEditTrainingError("Completed date is required");
      return;
    }
    if (editingTraining.id < 0) {
      setPendingAdds((prev) =>
        prev.map((p) =>
          p.tempId === editingTraining.id
            ? { ...p, completedDate: editingTraining.completedDate }
            : p
        )
      );
    } else {
      setPendingEdits((prev) => ({
        ...prev,
        [editingTraining.id]: editingTraining.completedDate,
      }));
    }
    setEditingTraining(null);
  };

  const handleAddTrainingConfirm = () => {
    setAddTrainingError("");
    const matches = trainingTitleMatches;
    if (!addTrainingForm.fullTitle || matches.length === 0) {
      setAddTrainingError("Pick a training");
      return;
    }
    if (!addTrainingForm.completedDate) {
      setAddTrainingError("Completed date is required");
      return;
    }
    let trainingTitle = addTrainingForm.trainingTitle;
    if (matches.length === 1) {
      trainingTitle = matches[0].trainingTitle;
    }
    if (!trainingTitle) {
      setAddTrainingError("Pick a specific training title");
      return;
    }
    const picked = matches.find((m) => m.trainingTitle === trainingTitle);
    if (!picked) {
      setAddTrainingError("Selected training is no longer available");
      return;
    }
    setPendingAdds((prev) => [
      ...prev,
      {
        tempId: -(Date.now() + prev.length),
        trainingTitle: picked.trainingTitle,
        fullTitle: picked.fullTitle,
        trainingType: picked.trainingType,
        productType: picked.productType,
        function: picked.function,
        completedDate: addTrainingForm.completedDate,
      },
    ]);
    setShowAddTraining(false);
    setAddTrainingForm({ fullTitle: "", trainingTitle: "", completedDate: "" });
  };

  const handleDeleteStudentConfirm = async () => {
    if (!student) return;
    setDeleteStudentError("");
    try {
      const res = await fetch(
        `/api/students/${encodeURIComponent(student.email)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete student");
      }
      router.push("/students");
    } catch (error) {
      setDeleteStudentError(
        error instanceof Error ? error.message : "Delete failed"
      );
    }
  };

  const visibleTrainings = useMemo<StudentTrainingRow[]>(() => {
    if (!student) return [];
    const real = student.trainings
      .filter((t) => !deletedTrainingIds.includes(t.id))
      .map((t) => {
        const overrideIso = pendingEdits[t.id];
        if (!overrideIso) return t;
        return {
          ...t,
          completedDate: formatDate(overrideIso),
          expiryDate: formatDate(
            new Date(
              new Date(overrideIso).setFullYear(
                new Date(overrideIso).getFullYear() + 2
              )
            )
          ),
          active: new Date(overrideIso) >= new Date(new Date().setFullYear(new Date().getFullYear() - 2)),
        };
      });
    const pending: StudentTrainingRow[] = pendingAdds.map((p) => ({
      id: p.tempId,
      fullTitle: `${p.fullTitle} (pending)`,
      link: null,
      trainingType: trainingTypeLabel(p.trainingType),
      productType: p.productType,
      function: p.function,
      completedDate: formatDate(p.completedDate),
      expiryDate: formatDate(
        new Date(
          new Date(p.completedDate).setFullYear(
            new Date(p.completedDate).getFullYear() + 2
          )
        )
      ),
      active: true,
    }));
    return [...pending, ...real];
  }, [student, deletedTrainingIds, pendingAdds, pendingEdits]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading student record...</div>
      </div>
    );
  }

  if (!student) {
    return (
      <div>
        <PageHeader title="Student Not Found" showBack />
        <p className="text-gray-500">The requested student could not be found.</p>
      </div>
    );
  }

  const activeCerts = visibleTrainings.filter(
    (t) => t.trainingType === "Certification" && t.active
  ).length;
  const activeAccred = visibleTrainings.filter(
    (t) => t.trainingType === "Accreditation" && t.active
  ).length;
  const activeILT = visibleTrainings.filter(
    (t) => t.trainingType === "Instructor-Led Training" && t.active
  ).length;

  const statCards = [
    {
      label: "Certifications Earned",
      value: activeCerts,
      icon: Award,
      color: "bg-indigo-50",
      iconColor: "text-indigo-500",
    },
    {
      label: "Accreditations Earned",
      value: activeAccred,
      icon: ShieldCheck,
      color: "bg-emerald-50",
      iconColor: "text-emerald-500",
    },
    {
      label: "Instructor-Led Trainings",
      value: activeILT,
      icon: GraduationCap,
      color: "bg-amber-50",
      iconColor: "text-amber-500",
    },
  ];

  const pendingChangesCount =
    deletedTrainingIds.length +
    pendingAdds.length +
    Object.keys(pendingEdits).length;

  return (
    <div>
      <PageHeader title="Student Record" showBack helpSlug="student-detail" />

      {/* Contact Card */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            {editing ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    value={editForm.fullName}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, fullName: e.target.value }))
                    }
                    className="border border-gray-300 rounded-lg px-3 py-2 text-lg font-bold w-full"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Email Address
                    </label>
                    <input
                      type="email"
                      value={editForm.email}
                      onChange={(e) =>
                        setEditForm((f) => ({ ...f, email: e.target.value }))
                      }
                      className="border border-gray-300 rounded-lg px-3 py-2 w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Theatre
                    </label>
                    <input
                      type="text"
                      value={editForm.theatre}
                      onChange={(e) =>
                        setEditForm((f) => ({ ...f, theatre: e.target.value }))
                      }
                      className="border border-gray-300 rounded-lg px-3 py-2 w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      Country
                    </label>
                    <input
                      type="text"
                      value={editForm.country}
                      onChange={(e) =>
                        setEditForm((f) => ({ ...f, country: e.target.value }))
                      }
                      className="border border-gray-300 rounded-lg px-3 py-2 w-full"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <>
                <h2 className="text-2xl font-bold text-gray-900">
                  {student.fullName}
                </h2>
                <div className="mt-2 flex flex-wrap gap-4 text-sm text-gray-600">
                  <span>{student.email}</span>
                  <span className="text-gray-300">|</span>
                  <span>{student.theatre}</span>
                  <span className="text-gray-300">|</span>
                  <span>{student.region || "No Region"}</span>
                  <span className="text-gray-300">|</span>
                  <span>{student.country}</span>
                </div>
              </>
            )}
          </div>
          <div className="flex gap-2">
            {isAdmin && (
              editing ? (
                <>
                  <button
                    onClick={() => {
                      setSaveError("");
                      setShowSaveConfirm(true);
                    }}
                    className="flex items-center gap-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm"
                  >
                    <Save size={16} /> Save
                  </button>
                  <button
                    onClick={handleCancelEdit}
                    className="flex items-center gap-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors text-sm"
                  >
                    <X size={16} /> Cancel
                  </button>
                  <button
                    onClick={() => {
                      setDeleteStudentError("");
                      setShowDeleteStudent(true);
                    }}
                    className="flex items-center gap-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm"
                  >
                    <Trash2 size={16} /> Delete Student
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setEditing(true)}
                  className="flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
                >
                  <Pencil size={16} /> Edit
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className="bg-white rounded-lg border border-gray-200 p-5 flex items-center gap-4"
            >
              <div className={`p-3 rounded-lg ${card.color}`}>
                <Icon size={24} className={card.iconColor} />
              </div>
              <div>
                <div className="text-2xl font-bold text-gray-900">{card.value}</div>
                <div className="text-sm text-gray-500">{card.label}</div>
              </div>
            </div>
          );
        })}
      </section>

      {/* Training Table Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">
          Certifications, Accreditations & Training
        </h3>
        {isAdmin && editing && (
          <button
            onClick={() => {
              setAddTrainingError("");
              setAddTrainingForm({
                fullTitle: "",
                trainingTitle: "",
                completedDate: "",
              });
              setShowAddTraining(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            <Plus size={16} /> Add Training
          </button>
        )}
      </div>
      <DataTable<StudentTrainingRow>
        data={visibleTrainings}
        columns={trainingColumns}
        defaultPageSize={25}
        defaultSortColumn="fullTitle"
        rowEdit={
          isAdmin && editing
            ? { label: "Edit", onEdit: handleEditTrainingClick }
            : undefined
        }
        rowDelete={
          isAdmin && editing
            ? { label: "Remove", onDelete: handleDeleteTraining }
            : undefined
        }
      />

      {/* Save Confirmation Modal */}
      <Modal
        open={showSaveConfirm}
        onClose={() => setShowSaveConfirm(false)}
        title="Confirm Changes"
        actions={
          <>
            <button
              onClick={() => setShowSaveConfirm(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Confirm Save"}
            </button>
          </>
        }
      >
        <p className="text-gray-600">
          Are you sure you want to save these changes?
          {pendingChangesCount > 0 && (
            <span className="block mt-2 text-sm text-gray-700">
              {pendingAdds.length > 0 && (
                <span className="block">
                  {pendingAdds.length} training record(s) will be added.
                </span>
              )}
              {Object.keys(pendingEdits).length > 0 && (
                <span className="block">
                  {Object.keys(pendingEdits).length} training record(s) will be
                  updated.
                </span>
              )}
              {deletedTrainingIds.length > 0 && (
                <span className="block text-red-600">
                  {deletedTrainingIds.length} training record(s) will be deleted.
                </span>
              )}
            </span>
          )}
        </p>
        {saveError && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
            {saveError}
          </div>
        )}
      </Modal>

      {/* Add Training Modal */}
      <Modal
        open={showAddTraining}
        onClose={() => setShowAddTraining(false)}
        title="Add Training Record"
        actions={
          <>
            <button
              onClick={() => setShowAddTraining(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleAddTrainingConfirm}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Add
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Training
            </label>
            <select
              value={addTrainingForm.fullTitle}
              onChange={(e) =>
                setAddTrainingForm((f) => ({
                  ...f,
                  fullTitle: e.target.value,
                  trainingTitle: "",
                }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
            >
              <option value="">Select a training...</option>
              {fullTitleOptions.map((opt) => (
                <option
                  key={`${opt.fullTitle}::${opt.trainingType}`}
                  value={opt.fullTitle}
                >
                  {opt.fullTitle} ({trainingTypeLabel(opt.trainingType)})
                </option>
              ))}
            </select>
          </div>
          {trainingTitleMatches.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Variant (Training Title)
              </label>
              <select
                value={addTrainingForm.trainingTitle}
                onChange={(e) =>
                  setAddTrainingForm((f) => ({
                    ...f,
                    trainingTitle: e.target.value,
                  }))
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
              >
                <option value="">Select a specific variant...</option>
                {trainingTitleMatches.map((t) => (
                  <option key={t.trainingTitle} value={t.trainingTitle}>
                    {t.trainingTitle} — {trainingTypeLabel(t.trainingType)} /{" "}
                    {t.productType} / {t.function}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                Multiple training titles share this display name. Pick the one
                that applies.
              </p>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Completed Date
            </label>
            <input
              type="date"
              value={addTrainingForm.completedDate}
              onChange={(e) =>
                setAddTrainingForm((f) => ({
                  ...f,
                  completedDate: e.target.value,
                }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">
              Expiry is automatically set to two years after the completed date.
            </p>
          </div>
          {addTrainingError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {addTrainingError}
            </div>
          )}
          <p className="text-xs text-gray-500">
            This change is queued. Click <strong>Save</strong> on the student
            record to commit.
          </p>
        </div>
      </Modal>

      {/* Edit Training Modal */}
      <Modal
        open={!!editingTraining}
        onClose={() => setEditingTraining(null)}
        title="Edit Training Record"
        actions={
          <>
            <button
              onClick={() => setEditingTraining(null)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveEditTraining}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Apply
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Training
            </label>
            <input
              type="text"
              readOnly
              value={editingTraining?.fullTitle ?? ""}
              className="w-full px-3 py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-700"
            />
            <p className="text-xs text-gray-400 mt-1">
              To change the training, remove this record and add a new one.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Completed Date
            </label>
            <input
              type="date"
              value={editingTraining?.completedDate ?? ""}
              onChange={(e) =>
                setEditingTraining((cur) =>
                  cur ? { ...cur, completedDate: e.target.value } : cur
                )
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">
              Expiry is automatically recalculated as two years after this date.
            </p>
          </div>
          {editTrainingError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {editTrainingError}
            </div>
          )}
          <p className="text-xs text-gray-500">
            This change is queued. Click <strong>Save</strong> on the student
            record to commit.
          </p>
        </div>
      </Modal>

      {/* Delete Student Confirmation Modal */}
      <Modal
        open={showDeleteStudent}
        onClose={() => setShowDeleteStudent(false)}
        title="Delete Student"
        actions={
          <>
            <button
              onClick={() => setShowDeleteStudent(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleDeleteStudentConfirm}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              Delete Student
            </button>
          </>
        }
      >
        <p className="text-gray-600">
          Are you sure you want to permanently delete{" "}
          <strong>{student.fullName}</strong> ({student.email})? All of their
          training records will also be removed. This action cannot be undone.
        </p>
        {deleteStudentError && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
            {deleteStudentError}
          </div>
        )}
      </Modal>
    </div>
  );
}
