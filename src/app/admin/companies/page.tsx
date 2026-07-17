"use client";

import { useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { Plus, Pencil, Trash2, Building2 } from "lucide-react";
import { useFetchJson } from "@/hooks/useFetchJson";

interface CompanyRow {
  id: number;
  name: string;
  studentCount: number;
  createdAt: string;
}

export default function CompaniesPage() {
  // `reload` is aliased as fetchCompanies so mutation handlers can refresh the
  // list; the hook derives `loading` without a setState-in-effect.
  const { data: companiesData, loading, reload: fetchCompanies } = useFetchJson<CompanyRow[]>("/api/admin/companies");
  const companies = companiesData ?? [];

  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState("");

  const [editCompany, setEditCompany] = useState<CompanyRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editError, setEditError] = useState("");

  const [deleteCompany, setDeleteCompany] = useState<CompanyRow | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const handleAdd = async () => {
    setAddError("");
    const res = await fetch("/api/admin/companies", {
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
    fetchCompanies();
  };

  const handleEdit = async () => {
    if (!editCompany) return;
    setEditError("");
    const res = await fetch(`/api/admin/companies/${editCompany.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName }),
    });
    const data = await res.json();
    if (!res.ok) {
      setEditError(data.error);
      return;
    }
    setEditCompany(null);
    fetchCompanies();
  };

  const handleDelete = async () => {
    if (!deleteCompany) return;
    setDeleteError("");
    const res = await fetch(`/api/admin/companies/${deleteCompany.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json();
      setDeleteError(data.error);
      return;
    }
    setDeleteCompany(null);
    fetchCompanies();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading companies...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Companies"
        showBack
        helpSlug="companies"
        rightContent={
          <button
            onClick={() => {
              setAddName("");
              setAddError("");
              setShowAdd(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            <Plus size={16} /> Add Company
          </button>
        }
      />

      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Name</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Students</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Created</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {companies.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                  No companies yet.
                </td>
              </tr>
            )}
            {companies.map((c) => (
              <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-700 font-medium flex items-center gap-2">
                  <Building2 size={14} className="text-gray-400" />
                  {c.name}
                </td>
                <td className="px-4 py-3 text-gray-700">{c.studentCount}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {new Date(c.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        setEditCompany(c);
                        setEditName(c.name);
                        setEditError("");
                      }}
                      className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                      title="Rename"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setDeleteCompany(c);
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

      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add Company"
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
        open={!!editCompany}
        onClose={() => setEditCompany(null)}
        title={`Rename Company: ${editCompany?.name}`}
        actions={
          <>
            <button onClick={() => setEditCompany(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
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
        open={!!deleteCompany}
        onClose={() => setDeleteCompany(null)}
        title="Delete Company"
        actions={
          <>
            <button onClick={() => setDeleteCompany(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleDelete} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete</button>
          </>
        }
      >
        <p className="text-gray-600">
          Are you sure you want to delete <strong>{deleteCompany?.name}</strong>? This cannot be undone.
        </p>
        {(deleteCompany?.studentCount ?? 0) > 0 && (
          <p className="mt-2 text-sm text-amber-700">
            This company has {deleteCompany?.studentCount} assigned student(s). Reassign them before deleting.
          </p>
        )}
        {deleteError && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{deleteError}</div>
        )}
      </Modal>
    </div>
  );
}
