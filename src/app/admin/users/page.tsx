"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { Plus, Pencil, Trash2, KeyRound, ShieldOff } from "lucide-react";
import { formatDateTime } from "@/lib/utils";

interface CompanyOption {
  id: number;
  name: string;
}

interface UserRow {
  id: number;
  username: string;
  displayName: string;
  role: string;
  mfaEnabled: boolean;
  mustEnableMfa: boolean;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: string;
  companies: CompanyOption[];
}

const ROLE_BADGE: Record<string, string> = {
  SuperAdmin: "bg-red-100 text-red-700",
  Admin: "bg-purple-100 text-purple-700",
  User: "bg-gray-100 text-gray-700",
};

export default function UserManagementPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    username: "",
    displayName: "",
    password: "",
    role: "User",
    companyIds: [] as number[],
    mustEnableMfa: true,
  });
  const [addError, setAddError] = useState("");

  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editForm, setEditForm] = useState({
    displayName: "",
    role: "",
    companyIds: [] as number[],
    mustEnableMfa: false,
  });
  const [editError, setEditError] = useState("");

  const [resetUser, setResetUser] = useState<UserRow | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetAdminPassword, setResetAdminPassword] = useState("");
  const [resetAdminMfaCode, setResetAdminMfaCode] = useState("");
  const [resetError, setResetError] = useState("");

  const [disableMfaUser, setDisableMfaUser] = useState<UserRow | null>(null);
  const [disableMfaPassword, setDisableMfaPassword] = useState("");
  const [disableMfaCode, setDisableMfaCode] = useState("");
  const [disableMfaError, setDisableMfaError] = useState("");

  const [deleteUser, setDeleteUser] = useState<UserRow | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const fetchUsers = async () => {
    const res = await fetch("/api/admin/users");
    if (res.ok) setUsers(await res.json());
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
    fetchUsers();
    fetchCompanies();
  }, []);

  const handleAddUser = async () => {
    setAddError("");
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(addForm),
    });
    const data = await res.json();
    if (!res.ok) {
      setAddError(data.error);
      return;
    }
    setShowAdd(false);
    setAddForm({ username: "", displayName: "", password: "", role: "User", companyIds: [], mustEnableMfa: true });
    fetchUsers();
  };

  const handleEditUser = async () => {
    if (!editUser) return;
    setEditError("");
    const res = await fetch(`/api/admin/users/${editUser.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editForm),
    });
    const data = await res.json();
    if (!res.ok) {
      setEditError(data.error);
      return;
    }
    setEditUser(null);
    fetchUsers();
  };

  const handleResetPassword = async () => {
    if (!resetUser) return;
    setResetError("");
    const res = await fetch(`/api/admin/users/${resetUser.id}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: resetPassword,
        adminPassword: resetAdminPassword,
        adminMfaCode: resetAdminMfaCode || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setResetError(data.error);
      return;
    }
    setResetUser(null);
    setResetPassword("");
    setResetAdminPassword("");
    setResetAdminMfaCode("");
  };

  const handleDeleteUser = async () => {
    if (!deleteUser) return;
    setDeleteError("");
    const res = await fetch(`/api/admin/users/${deleteUser.id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      setDeleteError(data.error);
      return;
    }
    setDeleteUser(null);
    fetchUsers();
  };

  const handleDisableMfa = async () => {
    if (!disableMfaUser) return;
    setDisableMfaError("");
    const res = await fetch("/api/auth/mfa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: disableMfaUser.id,
        password: disableMfaPassword,
        mfaCode: disableMfaCode || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setDisableMfaError(data.error || "Failed to disable MFA");
      return;
    }
    setDisableMfaUser(null);
    setDisableMfaPassword("");
    setDisableMfaCode("");
    fetchUsers();
  };

  const toggleCompanyId = (
    list: number[],
    id: number,
    setter: (arr: number[]) => void
  ) => {
    setter(list.includes(id) ? list.filter((c) => c !== id) : [...list, id]);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading users...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="User Management"
        showBack
        helpSlug="user-management"
        rightContent={
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            <Plus size={16} /> Add User
          </button>
        }
      />

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Username</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Display Name</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Role</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Companies</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">MFA</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Last login</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Last IP</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Created</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-700 font-medium">{user.username}</td>
                <td className="px-4 py-3 text-gray-700">{user.displayName}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${ROLE_BADGE[user.role] ?? "bg-gray-100 text-gray-700"}`}>
                    {user.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600 text-xs">
                  {user.role === "SuperAdmin" ? (
                    <span className="italic text-gray-400">All companies</span>
                  ) : user.companies.length === 0 ? (
                    <span className="text-amber-600">None — no data visible</span>
                  ) : (
                    user.companies.map((c) => c.name).join(", ")
                  )}
                </td>
                <td className="px-4 py-3">
                  {user.mfaEnabled ? (
                    <span className="text-green-600 text-xs font-medium">Enabled</span>
                  ) : user.mustEnableMfa ? (
                    <span className="text-amber-600 text-xs font-medium" title="Required at next login">
                      Required
                    </span>
                  ) : (
                    <span className="text-gray-400 text-xs">Disabled</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs font-mono">
                  {user.lastLoginIp ?? <span className="text-gray-300 font-sans">—</span>}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        setEditUser(user);
                        setEditForm({
                          displayName: user.displayName,
                          role: user.role,
                          companyIds: user.companies.map((c) => c.id),
                          mustEnableMfa: user.mustEnableMfa,
                        });
                        setEditError("");
                      }}
                      className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                      title="Edit user"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setResetUser(user);
                        setResetPassword("");
                        setResetError("");
                      }}
                      className="p-1.5 text-amber-600 hover:bg-amber-50 rounded"
                      title="Reset password"
                    >
                      <KeyRound size={14} />
                    </button>
                    {user.mfaEnabled && (
                      <button
                        onClick={() => {
                          setDisableMfaUser(user);
                          setDisableMfaPassword("");
                          setDisableMfaCode("");
                          setDisableMfaError("");
                        }}
                        className="p-1.5 text-orange-600 hover:bg-orange-50 rounded"
                        title="Disable MFA"
                      >
                        <ShieldOff size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setDeleteUser(user);
                        setDeleteError("");
                      }}
                      className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                      title="Delete user"
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
        title="Add User"
        actions={
          <>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleAddUser} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Create User</button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input
              type="text"
              value={addForm.username}
              onChange={(e) => setAddForm((f) => ({ ...f, username: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
            <input
              type="text"
              value={addForm.displayName}
              onChange={(e) => setAddForm((f) => ({ ...f, displayName: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={addForm.password}
              onChange={(e) => setAddForm((f) => ({ ...f, password: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">Min 8 characters with uppercase, lowercase, number, and special character</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
            <select
              value={addForm.role}
              onChange={(e) => setAddForm((f) => ({ ...f, role: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="User">User (read-only)</option>
              <option value="Admin">Admin (scoped)</option>
              <option value="SuperAdmin">SuperAdmin (full access)</option>
            </select>
          </div>
          {addForm.role !== "SuperAdmin" && (
            <CompanyPicker
              companies={companies}
              selected={addForm.companyIds}
              onToggle={(id) =>
                toggleCompanyId(addForm.companyIds, id, (arr) => setAddForm((f) => ({ ...f, companyIds: arr })))
              }
            />
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={addForm.mustEnableMfa}
              onChange={(e) => setAddForm((f) => ({ ...f, mustEnableMfa: e.target.checked }))}
            />
            Require MFA at first login
          </label>
          {addError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{addError}</div>
          )}
        </div>
      </Modal>

      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title={`Edit User: ${editUser?.username}`}
        actions={
          <>
            <button onClick={() => setEditUser(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleEditUser} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Save Changes</button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
            <input
              type="text"
              value={editForm.displayName}
              onChange={(e) => setEditForm((f) => ({ ...f, displayName: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
            <select
              value={editForm.role}
              onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="User">User (read-only)</option>
              <option value="Admin">Admin (scoped)</option>
              <option value="SuperAdmin">SuperAdmin (full access)</option>
            </select>
          </div>
          {editForm.role !== "SuperAdmin" && (
            <CompanyPicker
              companies={companies}
              selected={editForm.companyIds}
              onToggle={(id) =>
                toggleCompanyId(editForm.companyIds, id, (arr) => setEditForm((f) => ({ ...f, companyIds: arr })))
              }
            />
          )}
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editForm.mustEnableMfa}
                onChange={(e) => setEditForm((f) => ({ ...f, mustEnableMfa: e.target.checked }))}
                disabled={editUser?.mfaEnabled === true}
              />
              Require MFA at next login
            </label>
            {editUser?.mfaEnabled && (
              <p className="text-xs text-gray-400 mt-1 ml-6">
                User already has MFA enabled.
              </p>
            )}
          </div>
          {editError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{editError}</div>
          )}
        </div>
      </Modal>

      <Modal
        open={!!resetUser}
        onClose={() => {
          setResetUser(null);
          setResetPassword("");
          setResetAdminPassword("");
          setResetAdminMfaCode("");
        }}
        title={`Reset Password: ${resetUser?.username}`}
        actions={
          <>
            <button
              onClick={() => {
                setResetUser(null);
                setResetPassword("");
                setResetAdminPassword("");
                setResetAdminMfaCode("");
              }}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button onClick={handleResetPassword} className="px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700">Reset Password</button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
            <input
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">Min 8 characters with uppercase, lowercase, number, and special character</p>
          </div>
          <div className="border-t border-gray-200 pt-3">
            <p className="text-xs text-gray-500 mb-2">Re-authenticate to confirm this destructive action.</p>
            <label className="block text-sm font-medium text-gray-700 mb-1">Your password</label>
            <input
              type="password"
              value={resetAdminPassword}
              onChange={(e) => setResetAdminPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <label className="block text-sm font-medium text-gray-700 mb-1 mt-2">Your MFA code (if enabled)</label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={resetAdminMfaCode}
              onChange={(e) => setResetAdminMfaCode(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          {resetError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{resetError}</div>
          )}
        </div>
      </Modal>

      <Modal
        open={!!disableMfaUser}
        onClose={() => {
          setDisableMfaUser(null);
          setDisableMfaPassword("");
          setDisableMfaCode("");
        }}
        title={`Disable MFA: ${disableMfaUser?.username}`}
        actions={
          <>
            <button
              onClick={() => {
                setDisableMfaUser(null);
                setDisableMfaPassword("");
                setDisableMfaCode("");
              }}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button onClick={handleDisableMfa} className="px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700">Disable MFA</button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Disabling MFA for <strong>{disableMfaUser?.username}</strong> removes their second factor entirely. Re-authenticate with your own credentials to confirm.
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Your password</label>
            <input
              type="password"
              value={disableMfaPassword}
              onChange={(e) => setDisableMfaPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Your MFA code (if enabled)</label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={disableMfaCode}
              onChange={(e) => setDisableMfaCode(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          {disableMfaError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{disableMfaError}</div>
          )}
        </div>
      </Modal>

      <Modal
        open={!!deleteUser}
        onClose={() => setDeleteUser(null)}
        title="Delete User"
        actions={
          <>
            <button onClick={() => setDeleteUser(null)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleDeleteUser} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete User</button>
          </>
        }
      >
        <p className="text-gray-600">
          Are you sure you want to delete user <strong>{deleteUser?.username}</strong>? This action cannot be undone.
        </p>
        {deleteError && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{deleteError}</div>
        )}
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
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={() => onToggle(c.id)}
              />
              {c.name}
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-gray-400 mt-1">
        The user will only be able to view data for the selected companies. Leave empty for no access.
      </p>
    </div>
  );
}
