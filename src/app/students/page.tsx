"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import DataTable from "@/components/data-table/DataTable";
import Modal from "@/components/ui/Modal";
import { ColumnDef, StudentRow } from "@/types";
import { useAuth } from "@/components/auth/AuthProvider";
import { Plus } from "lucide-react";

const columns: ColumnDef<StudentRow>[] = [
  { key: "fullName", header: "Full Name" },
  { key: "email", header: "Email Address" },
  { key: "theatre", header: "Theatre" },
  { key: "region", header: "Region", accessor: (row) => row.region || "N/A" },
  { key: "country", header: "Country" },
];

export default function StudentsPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastImport, setLastImport] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    email: "",
    fullName: "",
    theatre: "",
    country: "",
  });
  const [addError, setAddError] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchStudents = () =>
    fetch("/api/students")
      .then((res) => res.json())
      .then((data) => setStudents(data));

  useEffect(() => {
    fetchStudents().finally(() => setLoading(false));
    fetch("/api/import-metadata?key=students")
      .then((res) => res.json())
      .then((data) => {
        if (data?.timestamp) setLastImport(data.timestamp);
      })
      .catch(() => {});
  }, []);

  const handleAddStudent = async () => {
    setAddError("");
    setSaving(true);
    try {
      const res = await fetch("/api/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addForm),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.error || "Failed to create student");
        return;
      }
      setShowAdd(false);
      setAddForm({ email: "", fullName: "", theatre: "", country: "" });
      await fetchStudents();
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading students...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Students"
        helpSlug="students"
        rightContent={
          <div className="flex items-center gap-4">
            {lastImport && (
              <span className="text-sm text-gray-500">
                Last imported: {new Date(lastImport).toLocaleString()}
              </span>
            )}
            {isAdmin && (
              <button
                onClick={() => {
                  setAddError("");
                  setAddForm({ email: "", fullName: "", theatre: "", country: "" });
                  setShowAdd(true);
                }}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
              >
                <Plus size={16} /> Add Student
              </button>
            )}
          </div>
        }
      />
      <DataTable<StudentRow>
        data={students}
        columns={columns}
        defaultSortColumn="fullName"
        rowAction={{
          label: "View",
          onClick: (row) =>
            router.push(`/students/${encodeURIComponent(row.email)}`),
        }}
      />

      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add Student"
        actions={
          <>
            <button
              onClick={() => setShowAdd(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleAddStudent}
              disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Creating..." : "Create Student"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Full Name
            </label>
            <input
              type="text"
              value={addForm.fullName}
              onChange={(e) =>
                setAddForm((f) => ({ ...f, fullName: e.target.value }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email Address
            </label>
            <input
              type="email"
              value={addForm.email}
              onChange={(e) =>
                setAddForm((f) => ({ ...f, email: e.target.value }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Theatre
            </label>
            <input
              type="text"
              value={addForm.theatre}
              onChange={(e) =>
                setAddForm((f) => ({ ...f, theatre: e.target.value }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Country
            </label>
            <input
              type="text"
              value={addForm.country}
              onChange={(e) =>
                setAddForm((f) => ({ ...f, country: e.target.value }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">
              Region is auto-derived from the country&apos;s entry in Region Data.
            </p>
          </div>
          {addError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {addError}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
