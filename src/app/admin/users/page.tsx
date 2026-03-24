"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { Plus, Pencil, Trash2, KeyRound, ShieldOff } from "lucide-react";

interface UserRow {
  id: number;
  username: string;
  displayName: string;
  role: string;
  mfaEnabled: boolean;
  createdAt: string;
}

export default function UserManagementPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Add user modal
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    username: "",
    displayName: "",
    password: "",
    role: "User",
  });
  const [addError, setAddError] = useState("");

  // Edit user modal
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editForm, setEditForm] = useState({ displayName: "", role: "" });
  const [editError, setEditError] = useState("");

  // Reset password modal
  const [resetUser, setResetUser] = useState<UserRow | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetError, setResetError] = useState("");

  // Delete confirm modal
  const [deleteUser, setDeleteUser] = useState<UserRow | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const fetchUsers = async () => {
    const res = await fetch("/api/admin/users");
    if (res.ok) {
      setUsers(await res.json());
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchUsers();
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
    setAddForm({ username: "", displayName: "", password: "", role: "User" });
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
    const res = await fetch(
      `/api/admin/users/${resetUser.id}/reset-password`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPassword }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      setResetError(data.error);
      return;
    }
    setResetUser(null);
    setResetPassword("");
  };

  const handleDeleteUser = async () => {
    if (!deleteUser) return;
    setDeleteError("");
    const res = await fetch(`/api/admin/users/${deleteUser.id}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (!res.ok) {
      setDeleteError(data.error);
      return;
    }
    setDeleteUser(null);
    fetchUsers();
  };

  const handleDisableMfa = async (user: UserRow) => {
    await fetch("/api/auth/mfa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id }),
    });
    fetchUsers();
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
              <th className="px-4 py-3 text-left font-semibold text-gray-700">
                Username
              </th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">
                Display Name
              </th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">
                Role
              </th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">
                MFA
              </th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">
                Created
              </th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr
                key={user.id}
                className="border-b border-gray-100 hover:bg-gray-50"
              >
                <td className="px-4 py-3 text-gray-700 font-medium">
                  {user.username}
                </td>
                <td className="px-4 py-3 text-gray-700">{user.displayName}</td>
                <td className="px-4 py-3">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      user.role === "Admin"
                        ? "bg-purple-100 text-purple-700"
                        : "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {user.role}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {user.mfaEnabled ? (
                    <span className="text-green-600 text-xs font-medium">
                      Enabled
                    </span>
                  ) : (
                    <span className="text-gray-400 text-xs">Disabled</span>
                  )}
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
                        onClick={() => handleDisableMfa(user)}
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

      {/* Add User Modal */}
      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add User"
        actions={
          <>
            <button
              onClick={() => setShowAdd(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleAddUser}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Create User
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Username
            </label>
            <input
              type="text"
              value={addForm.username}
              onChange={(e) =>
                setAddForm((f) => ({ ...f, username: e.target.value }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Display Name
            </label>
            <input
              type="text"
              value={addForm.displayName}
              onChange={(e) =>
                setAddForm((f) => ({ ...f, displayName: e.target.value }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              type="password"
              value={addForm.password}
              onChange={(e) =>
                setAddForm((f) => ({ ...f, password: e.target.value }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">Minimum 8 characters</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Role
            </label>
            <select
              value={addForm.role}
              onChange={(e) =>
                setAddForm((f) => ({ ...f, role: e.target.value }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="User">User</option>
              <option value="Admin">Admin</option>
            </select>
          </div>
          {addError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {addError}
            </div>
          )}
        </div>
      </Modal>

      {/* Edit User Modal */}
      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title={`Edit User: ${editUser?.username}`}
        actions={
          <>
            <button
              onClick={() => setEditUser(null)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleEditUser}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Save Changes
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Display Name
            </label>
            <input
              type="text"
              value={editForm.displayName}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, displayName: e.target.value }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Role
            </label>
            <select
              value={editForm.role}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, role: e.target.value }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="User">User</option>
              <option value="Admin">Admin</option>
            </select>
          </div>
          {editError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {editError}
            </div>
          )}
        </div>
      </Modal>

      {/* Reset Password Modal */}
      <Modal
        open={!!resetUser}
        onClose={() => setResetUser(null)}
        title={`Reset Password: ${resetUser?.username}`}
        actions={
          <>
            <button
              onClick={() => setResetUser(null)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleResetPassword}
              className="px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700"
            >
              Reset Password
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              New Password
            </label>
            <input
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">Minimum 8 characters</p>
          </div>
          {resetError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {resetError}
            </div>
          )}
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={!!deleteUser}
        onClose={() => setDeleteUser(null)}
        title="Delete User"
        actions={
          <>
            <button
              onClick={() => setDeleteUser(null)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleDeleteUser}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              Delete User
            </button>
          </>
        }
      >
        <p className="text-gray-600">
          Are you sure you want to delete user{" "}
          <strong>{deleteUser?.username}</strong>? This action cannot be undone.
        </p>
        {deleteError && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
            {deleteError}
          </div>
        )}
      </Modal>
    </div>
  );
}
