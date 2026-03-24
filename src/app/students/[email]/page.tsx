"use client";

import { useEffect, useState, use } from "react";
import PageHeader from "@/components/layout/PageHeader";
import DataTable from "@/components/data-table/DataTable";
import Badge from "@/components/ui/Badge";
import Modal from "@/components/ui/Modal";
import { ColumnDef, StudentRecord, StudentTrainingRow } from "@/types";
import { Pencil, Save, X, Award, ShieldCheck, GraduationCap } from "lucide-react";

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

export default function StudentRecordPage({
  params,
}: {
  params: Promise<{ email: string }>;
}) {
  const resolvedParams = use(params);
  const email = decodeURIComponent(resolvedParams.email);

  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    fullName: "",
    email: "",
    theatre: "",
    country: "",
  });
  const [deletedTrainingIds, setDeletedTrainingIds] = useState<number[]>([]);
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

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

  const handleSave = async () => {
    if (!student) return;
    setSaving(true);

    try {
      // Update student details
      await fetch(`/api/students/${encodeURIComponent(student.email)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: editForm.fullName,
          newEmail: editForm.email !== student.email ? editForm.email : undefined,
          theatre: editForm.theatre,
          country: editForm.country,
        }),
      });

      // Delete removed trainings
      for (const id of deletedTrainingIds) {
        await fetch(`/api/training-taken/${id}`, { method: "DELETE" });
      }

      // Reload data
      const targetEmail = editForm.email || student.email;
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
      setEditing(false);

      // Update URL if email changed
      if (editForm.email !== student.email) {
        window.history.replaceState(
          null,
          "",
          `/students/${encodeURIComponent(targetEmail)}`
        );
      }
    } catch (error) {
      console.error("Save failed:", error);
    } finally {
      setSaving(false);
      setShowSaveConfirm(false);
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
    setEditing(false);
  };

  const handleDeleteTraining = (row: StudentTrainingRow) => {
    setDeletedTrainingIds((prev) => [...prev, row.id]);
  };

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

  const visibleTrainings = student.trainings.filter(
    (t) => !deletedTrainingIds.includes(t.id)
  );

  const activeCerts = visibleTrainings.filter(
    (t) => t.trainingType === "Certification" && t.active
  ).length;
  const activeAccred = visibleTrainings.filter(
    (t) => t.trainingType === "Accreditation" && t.active
  ).length;
  const activeILT = visibleTrainings.filter(
    (t) => t.trainingType === "InstructorLedTraining" && t.active
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
            {editing ? (
              <>
                <button
                  onClick={() => setShowSaveConfirm(true)}
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
              </>
            ) : (
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
              >
                <Pencil size={16} /> Edit
              </button>
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

      {/* Training Table */}
      <h3 className="text-lg font-semibold mb-3">
        Certifications, Accreditations & Training
      </h3>
      <DataTable<StudentTrainingRow>
        data={visibleTrainings}
        columns={trainingColumns}
        defaultPageSize={25}
        rowDelete={
          editing
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
          {deletedTrainingIds.length > 0 && (
            <span className="block mt-2 text-red-600">
              {deletedTrainingIds.length} training record(s) will be deleted.
            </span>
          )}
        </p>
      </Modal>
    </div>
  );
}
