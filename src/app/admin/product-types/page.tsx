"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { Plus, Pencil, Trash2, Tag } from "lucide-react";

interface ProductTypeRow {
  id: number;
  name: string;
  trainingCount: number;
}

export default function ProductTypesPage() {
  const [productTypes, setProductTypes] = useState<ProductTypeRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState("");

  const [editProductType, setEditProductType] = useState<ProductTypeRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editError, setEditError] = useState("");

  const [deleteProductType, setDeleteProductType] = useState<ProductTypeRow | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const fetchProductTypes = async () => {
    const res = await fetch("/api/admin/product-types");
    if (res.ok) setProductTypes(await res.json());
    setLoading(false);
  };

  useEffect(() => {
    fetchProductTypes();
  }, []);

  const handleAdd = async () => {
    setAddError("");
    const res = await fetch("/api/admin/product-types", {
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
    fetchProductTypes();
  };

  const handleEdit = async () => {
    if (!editProductType) return;
    setEditError("");
    const res = await fetch(`/api/admin/product-types/${editProductType.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName }),
    });
    const data = await res.json();
    if (!res.ok) {
      setEditError(data.error);
      return;
    }
    setEditProductType(null);
    fetchProductTypes();
  };

  const handleDelete = async () => {
    if (!deleteProductType) return;
    setDeleteError("");
    const res = await fetch(`/api/admin/product-types/${deleteProductType.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json();
      setDeleteError(data.error);
      return;
    }
    setDeleteProductType(null);
    fetchProductTypes();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading product types...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Product Types"
        showBack
        helpSlug="admin-product-types"
        rightContent={
          <button
            onClick={() => {
              setAddName("");
              setAddError("");
              setShowAdd(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            <Plus size={16} /> Add Product Type
          </button>
        }
      />

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Name</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Trainings</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {productTypes.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-gray-500">
                  No product types yet.
                </td>
              </tr>
            )}
            {productTypes.map((pt) => (
              <tr key={pt.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-700 font-medium flex items-center gap-2">
                  <Tag size={14} className="text-gray-400" />
                  {pt.name}
                </td>
                <td className="px-4 py-3 text-gray-700">{pt.trainingCount}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        setEditProductType(pt);
                        setEditName(pt.name);
                        setEditError("");
                      }}
                      className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                      title="Rename"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setDeleteProductType(pt);
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
        title="Add Product Type"
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
        open={!!editProductType}
        onClose={() => setEditProductType(null)}
        title={`Rename Product Type: ${editProductType?.name}`}
        actions={
          <>
            <button onClick={() => setEditProductType(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
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
        open={!!deleteProductType}
        onClose={() => setDeleteProductType(null)}
        title="Delete Product Type"
        actions={
          <>
            <button onClick={() => setDeleteProductType(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleDelete} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete</button>
          </>
        }
      >
        <p className="text-gray-600">
          Are you sure you want to delete <strong>{deleteProductType?.name}</strong>? This cannot be undone.
        </p>
        {(deleteProductType?.trainingCount ?? 0) > 0 && (
          <p className="mt-2 text-sm text-amber-700">
            This product type is used by {deleteProductType?.trainingCount} training(s). Reassign them before deleting.
          </p>
        )}
        {deleteError && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{deleteError}</div>
        )}
      </Modal>
    </div>
  );
}
