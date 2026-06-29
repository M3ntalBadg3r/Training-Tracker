"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { Plus, Trash2, Pencil, Ban, Power, Copy, Check } from "lucide-react";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";

interface CompanyOption {
  id: number;
  name: string;
}

interface ApiKeyRow {
  id: number;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  createdAt: string;
  companies: CompanyOption[];
}

function keyStatus(key: ApiKeyRow): { label: string; className: string } {
  if (key.revokedAt) return { label: "Revoked", className: "bg-red-100 text-red-700" };
  if (key.expiresAt && new Date(key.expiresAt) <= new Date())
    return { label: "Expired", className: "bg-amber-100 text-amber-700" };
  if (!key.enabled) return { label: "Disabled", className: "bg-gray-100 text-gray-600" };
  return { label: "Active", className: "bg-green-100 text-green-700" };
}

export default function ApiKeysPage() {
  const { formatDateTime } = useDateFormat();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", companyIds: [] as number[], expiresAt: "" });
  const [addError, setAddError] = useState("");

  const [editKey, setEditKey] = useState<ApiKeyRow | null>(null);
  const [editForm, setEditForm] = useState({ name: "", companyIds: [] as number[], expiresAt: "" });
  const [editError, setEditError] = useState("");

  const [deleteKey, setDeleteKey] = useState<ApiKeyRow | null>(null);
  const [revokeKey, setRevokeKey] = useState<ApiKeyRow | null>(null);

  // The plaintext key is shown exactly once, immediately after creation.
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchKeys = async () => {
    const res = await fetch("/api/admin/api-keys");
    if (res.ok) setKeys(await res.json());
    setLoading(false);
  };

  const fetchCompanies = async () => {
    const res = await fetch("/api/admin/companies");
    if (res.ok) {
      const data = (await res.json()) as { id: number; name: string }[];
      setCompanies(data.map((c) => ({ id: c.id, name: c.name })));
    }
  };

  useEffect(() => {
    fetchKeys();
    fetchCompanies();
  }, []);

  const handleAdd = async () => {
    setAddError("");
    const res = await fetch("/api/admin/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: addForm.name,
        companyIds: addForm.companyIds,
        expiresAt: addForm.expiresAt || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setAddError(data.error || "Failed to create key");
      return;
    }
    setShowAdd(false);
    setAddForm({ name: "", companyIds: [], expiresAt: "" });
    setCreatedKey(data.plaintextKey);
    setCopied(false);
    fetchKeys();
  };

  const handleEdit = async () => {
    if (!editKey) return;
    setEditError("");
    const res = await fetch(`/api/admin/api-keys/${editKey.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editForm.name,
        companyIds: editForm.companyIds,
        expiresAt: editForm.expiresAt || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setEditError(data.error || "Failed to update key");
      return;
    }
    setEditKey(null);
    fetchKeys();
  };

  const toggleEnabled = async (key: ApiKeyRow) => {
    await fetch(`/api/admin/api-keys/${key.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !key.enabled }),
    });
    fetchKeys();
  };

  const handleRevoke = async () => {
    if (!revokeKey) return;
    await fetch(`/api/admin/api-keys/${revokeKey.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revoked: true }),
    });
    setRevokeKey(null);
    fetchKeys();
  };

  const handleDelete = async () => {
    if (!deleteKey) return;
    await fetch(`/api/admin/api-keys/${deleteKey.id}`, { method: "DELETE" });
    setDeleteKey(null);
    fetchKeys();
  };

  const copyKey = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
    } catch {
      /* clipboard unavailable — the user can select the text manually */
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading API keys...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        showBack
        helpSlug="api-keys"
        rightContent={
          <button
            onClick={() => {
              setAddForm({ name: "", companyIds: [], expiresAt: "" });
              setAddError("");
              setShowAdd(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            <Plus size={16} /> New API Key
          </button>
        }
      />

      <p className="mb-4 text-sm text-gray-500">
        API keys grant <strong>read-only</strong> access to the public API for the selected
        companies. Send a key as an <code>Authorization: Bearer</code> header. The full key is
        shown only once, when it is created.
      </p>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Name</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Key</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Companies</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Status</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Last used</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Expires</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  No API keys yet. Create one to allow a third-party system to read your data.
                </td>
              </tr>
            ) : (
              keys.map((key) => {
                const status = keyStatus(key);
                const revoked = !!key.revokedAt;
                return (
                  <tr key={key.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-700 font-medium">{key.name}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs font-mono">{key.keyPrefix}…</td>
                    <td className="px-4 py-3 text-gray-600 text-xs">
                      {key.companies.length === 0 ? (
                        <span className="text-amber-600">None</span>
                      ) : (
                        key.companies.map((c) => c.name).join(", ")
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${status.className}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : <span className="text-gray-300">Never</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {!revoked && (
                          <>
                            <button
                              onClick={() => {
                                setEditKey(key);
                                setEditForm({
                                  name: key.name,
                                  companyIds: key.companies.map((c) => c.id),
                                  expiresAt: key.expiresAt ? key.expiresAt.slice(0, 10) : "",
                                });
                                setEditError("");
                              }}
                              className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                              title="Edit"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => toggleEnabled(key)}
                              className="p-1.5 text-amber-600 hover:bg-amber-50 rounded"
                              title={key.enabled ? "Disable" : "Enable"}
                            >
                              <Power size={14} />
                            </button>
                            <button
                              onClick={() => setRevokeKey(key)}
                              className="p-1.5 text-orange-600 hover:bg-orange-50 rounded"
                              title="Revoke"
                            >
                              <Ban size={14} />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => setDeleteKey(key)}
                          className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Create */}
      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="New API Key"
        actions={
          <>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleAdd} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Create Key</button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={addForm.name}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Partner CRM sync"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <CompanyPicker
            companies={companies}
            selected={addForm.companyIds}
            onToggle={(id) =>
              setAddForm((f) => ({
                ...f,
                companyIds: f.companyIds.includes(id) ? f.companyIds.filter((c) => c !== id) : [...f.companyIds, id],
              }))
            }
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Expiry (optional)</label>
            <input
              type="date"
              value={addForm.expiresAt}
              onChange={(e) => setAddForm((f) => ({ ...f, expiresAt: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">Leave blank for a key that never expires.</p>
          </div>
          {addError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{addError}</div>
          )}
        </div>
      </Modal>

      {/* Show created key once */}
      <Modal
        open={!!createdKey}
        onClose={() => setCreatedKey(null)}
        title="API Key Created"
        actions={
          <button onClick={() => setCreatedKey(null)} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Done</button>
        }
      >
        <div className="space-y-3">
          <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
            Copy this key now — it will <strong>not</strong> be shown again. Store it somewhere safe.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-gray-100 rounded-lg text-xs font-mono break-all">{createdKey}</code>
            <button
              onClick={copyKey}
              className="flex items-center gap-1 px-3 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300 shrink-0"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </Modal>

      {/* Edit */}
      <Modal
        open={!!editKey}
        onClose={() => setEditKey(null)}
        title={`Edit API Key: ${editKey?.name ?? ""}`}
        actions={
          <>
            <button onClick={() => setEditKey(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleEdit} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Save Changes</button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={editForm.name}
              onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <CompanyPicker
            companies={companies}
            selected={editForm.companyIds}
            onToggle={(id) =>
              setEditForm((f) => ({
                ...f,
                companyIds: f.companyIds.includes(id) ? f.companyIds.filter((c) => c !== id) : [...f.companyIds, id],
              }))
            }
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Expiry (optional)</label>
            <input
              type="date"
              value={editForm.expiresAt}
              onChange={(e) => setEditForm((f) => ({ ...f, expiresAt: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          {editError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{editError}</div>
          )}
        </div>
      </Modal>

      {/* Revoke */}
      <Modal
        open={!!revokeKey}
        onClose={() => setRevokeKey(null)}
        title="Revoke API Key"
        actions={
          <>
            <button onClick={() => setRevokeKey(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleRevoke} className="px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700">Revoke Key</button>
          </>
        }
      >
        <p className="text-gray-600">
          Revoke <strong>{revokeKey?.name}</strong>? Any system using this key will immediately
          lose access. This cannot be undone.
        </p>
      </Modal>

      {/* Delete */}
      <Modal
        open={!!deleteKey}
        onClose={() => setDeleteKey(null)}
        title="Delete API Key"
        actions={
          <>
            <button onClick={() => setDeleteKey(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleDelete} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete Key</button>
          </>
        }
      >
        <p className="text-gray-600">
          Permanently delete <strong>{deleteKey?.name}</strong>? Any system using this key will
          lose access. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

function CompanyPicker({
  companies,
  selected,
  onToggle,
}: {
  companies: CompanyOption[];
  selected: number[];
  onToggle: (id: number) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">Companies</label>
      {companies.length === 0 ? (
        <p className="text-xs text-gray-500">No companies exist. Create one in Admin → Companies.</p>
      ) : (
        <div className="border border-gray-300 rounded-lg p-2 max-h-40 overflow-y-auto space-y-1">
          {companies.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={selected.includes(c.id)} onChange={() => onToggle(c.id)} />
              {c.name}
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-gray-400 mt-1">The key can only read data for the selected companies.</p>
    </div>
  );
}
