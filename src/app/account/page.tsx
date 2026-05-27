"use client";

import { useState, useEffect } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { useAuth } from "@/components/auth/AuthProvider";
import { ShieldCheck, ShieldOff, KeyRound, CalendarDays, CheckCircle } from "lucide-react";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import { DATE_FORMATS, formatDateWith, type DateFormat } from "@/lib/date-format";

export default function AccountPage() {
  const { user } = useAuth();
  const { userFormat, systemFormat, setUserFormat } = useDateFormat();
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  // "system" means inherit; otherwise the override is one of DATE_FORMATS.
  const [pendingFormat, setPendingFormat] = useState<DateFormat | "system">(userFormat ?? "system");
  const [savingFormat, setSavingFormat] = useState(false);
  const [formatSaved, setFormatSaved] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);

  useEffect(() => {
    setPendingFormat(userFormat ?? "system");
  }, [userFormat]);

  // MFA Setup state
  const [showMfaSetup, setShowMfaSetup] = useState(false);
  const [qrCode, setQrCode] = useState("");
  const [mfaSecret, setMfaSecret] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [setupError, setSetupError] = useState("");
  const [setupLoading, setSetupLoading] = useState(false);

  // Change Password state
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [changePasswordError, setChangePasswordError] = useState("");
  const [changePasswordSuccess, setChangePasswordSuccess] = useState(false);

  // MFA Disable state
  const [showMfaDisable, setShowMfaDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableError, setDisableError] = useState("");

  useEffect(() => {
    fetchMfaStatus();
  }, []);

  const fetchMfaStatus = async () => {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        setMfaEnabled(data.mfaEnabled ?? false);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleStartMfaSetup = async () => {
    setSetupError("");
    setSetupLoading(true);
    try {
      const res = await fetch("/api/auth/mfa/setup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setSetupError(data.error || "Failed to start MFA setup");
        setSetupLoading(false);
        return;
      }
      setQrCode(data.qrCode);
      setMfaSecret(data.secret);
      setShowMfaSetup(true);
    } catch {
      setSetupError("Failed to connect to server");
    }
    setSetupLoading(false);
  };

  const handleVerifyMfa = async () => {
    setSetupError("");
    const res = await fetch("/api/auth/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: verifyCode }),
    });
    const data = await res.json();
    if (!res.ok) {
      setSetupError(data.error || "Verification failed");
      return;
    }
    setShowMfaSetup(false);
    setVerifyCode("");
    setQrCode("");
    setMfaSecret("");
    setMfaEnabled(true);
  };

  const handleDisableMfa = async () => {
    setDisableError("");
    const res = await fetch("/api/auth/mfa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: disablePassword }),
    });
    const data = await res.json();
    if (!res.ok) {
      setDisableError(data.error || "Failed to disable MFA");
      return;
    }
    setShowMfaDisable(false);
    setDisablePassword("");
    setMfaEnabled(false);
  };

  const handleSaveFormat = async () => {
    setSavingFormat(true);
    setFormatError(null);
    setFormatSaved(false);
    try {
      const next = pendingFormat === "system" ? null : pendingFormat;
      const res = await fetch("/api/account/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFormat: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFormatError(data.error || "Failed to save");
        return;
      }
      setUserFormat(next);
      setFormatSaved(true);
    } finally {
      setSavingFormat(false);
    }
  };

  const handleChangePassword = async () => {
    setChangePasswordError("");
    setChangePasswordSuccess(false);

    if (newPassword !== confirmNewPassword) {
      setChangePasswordError("New passwords do not match");
      return;
    }

    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) {
      setChangePasswordError(data.error || "Failed to change password");
      return;
    }
    setChangePasswordSuccess(true);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmNewPassword("");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="My Account" helpSlug="account" />

      <div className="max-w-2xl space-y-6">
        {/* Account Info */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Account Information
          </h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Username</span>
              <p className="font-medium text-gray-900">{user?.username}</p>
            </div>
            <div>
              <span className="text-gray-500">Display Name</span>
              <p className="font-medium text-gray-900">{user?.displayName}</p>
            </div>
            <div>
              <span className="text-gray-500">Role</span>
              <p className="font-medium text-gray-900">{user?.role}</p>
            </div>
          </div>
        </div>

        {/* Display Date Format Section */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2 flex items-center gap-2">
            <CalendarDays size={18} className="text-gray-500" />
            Display Date Format
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Choose how dates are shown across the app. This only changes your view;
            the data is stored in a format-neutral way and other users keep their
            own preference.
          </p>

          <div className="space-y-2">
            <label
              className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                pendingFormat === "system" ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <input
                type="radio"
                name="userDateFormat"
                checked={pendingFormat === "system"}
                onChange={() => setPendingFormat("system")}
                className="text-blue-600"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-gray-900">Use system default</div>
                <div className="text-xs text-gray-500">
                  Currently: {systemFormat} (e.g. {formatDateWith(new Date(Date.UTC(2026, 4, 27)), systemFormat)})
                </div>
              </div>
            </label>
            {DATE_FORMATS.map((opt) => (
              <label
                key={opt}
                className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                  pendingFormat === opt ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <input
                  type="radio"
                  name="userDateFormat"
                  checked={pendingFormat === opt}
                  onChange={() => setPendingFormat(opt)}
                  className="text-blue-600"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-900">{opt}</div>
                  <div className="text-xs text-gray-500">
                    Example: {formatDateWith(new Date(Date.UTC(2026, 4, 27)), opt)}
                  </div>
                </div>
              </label>
            ))}
          </div>

          {formatError && (
            <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {formatError}
            </div>
          )}
          {formatSaved && (
            <div className="mt-3 flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-2">
              <CheckCircle size={14} /> Saved.
            </div>
          )}

          <button
            onClick={handleSaveFormat}
            disabled={savingFormat || pendingFormat === (userFormat ?? "system")}
            className="mt-4 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {savingFormat ? "Saving..." : "Save Preference"}
          </button>
        </div>

        {/* Change Password Section */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Change Password
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Update your password to keep your account secure.
          </p>
          <button
            onClick={() => {
              setShowChangePassword(true);
              setCurrentPassword("");
              setNewPassword("");
              setConfirmNewPassword("");
              setChangePasswordError("");
              setChangePasswordSuccess(false);
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <KeyRound size={16} />
            Change Password
          </button>
        </div>

        {/* MFA Section */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Multi-Factor Authentication
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Add an extra layer of security by requiring a code from your
            authenticator app when signing in.
          </p>

          {mfaEnabled ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-green-600">
                <ShieldCheck size={20} />
                <span className="text-sm font-medium">MFA is enabled</span>
              </div>
              <button
                onClick={() => {
                  setShowMfaDisable(true);
                  setDisablePassword("");
                  setDisableError("");
                }}
                className="flex items-center gap-2 px-4 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
              >
                <ShieldOff size={16} />
                Disable MFA
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-gray-400">
                <ShieldOff size={20} />
                <span className="text-sm">MFA is not enabled</span>
              </div>
              <button
                onClick={handleStartMfaSetup}
                disabled={setupLoading}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                <ShieldCheck size={16} />
                {setupLoading ? "Setting up..." : "Enable MFA"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Change Password Modal */}
      <Modal
        open={showChangePassword}
        onClose={() => setShowChangePassword(false)}
        title="Change Password"
        actions={
          <>
            <button
              onClick={() => setShowChangePassword(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleChangePassword}
              disabled={!currentPassword || !newPassword || !confirmNewPassword}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              Change Password
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Current Password
            </label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              New Password
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">
              Min 8 characters with uppercase, lowercase, number, and special character
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Confirm New Password
            </label>
            <input
              type="password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          {changePasswordError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {changePasswordError}
            </div>
          )}
          {changePasswordSuccess && (
            <div className="text-sm text-green-600 bg-green-50 border border-green-200 rounded-lg p-2">
              Password changed successfully.
            </div>
          )}
        </div>
      </Modal>

      {/* MFA Setup Modal */}
      <Modal
        open={showMfaSetup}
        onClose={() => {
          setShowMfaSetup(false);
          setVerifyCode("");
          setSetupError("");
        }}
        title="Set Up Multi-Factor Authentication"
        actions={
          <>
            <button
              onClick={() => {
                setShowMfaSetup(false);
                setVerifyCode("");
                setSetupError("");
              }}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleVerifyMfa}
              disabled={verifyCode.length !== 6}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              Verify &amp; Enable
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <p className="text-sm text-gray-600 mb-3">
              Scan the QR code below with your authenticator app (Google
              Authenticator, Authy, Microsoft Authenticator, etc.).
            </p>
            {qrCode && (
              <div className="flex justify-center">
                <img src={qrCode} alt="MFA QR Code" className="w-48 h-48" />
              </div>
            )}
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">
              Or enter this key manually:
            </p>
            <code className="block text-xs bg-gray-100 p-2 rounded text-center font-mono break-all select-all">
              {mfaSecret}
            </code>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Enter the 6-digit code from your app to verify
            </label>
            <input
              type="text"
              value={verifyCode}
              onChange={(e) =>
                setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="000000"
              maxLength={6}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-center text-2xl tracking-widest font-mono"
            />
          </div>
          {setupError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {setupError}
            </div>
          )}
        </div>
      </Modal>

      {/* Disable MFA Modal */}
      <Modal
        open={showMfaDisable}
        onClose={() => setShowMfaDisable(false)}
        title="Disable Multi-Factor Authentication"
        actions={
          <>
            <button
              onClick={() => setShowMfaDisable(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleDisableMfa}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              Disable MFA
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Enter your password to confirm disabling MFA. You will no longer
            need a code from your authenticator app to sign in.
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              type="password"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          {disableError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {disableError}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
