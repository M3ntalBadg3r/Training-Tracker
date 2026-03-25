"use client";

import { useState, useEffect } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { useAuth } from "@/components/auth/AuthProvider";
import { ShieldCheck, ShieldOff } from "lucide-react";

export default function AccountPage() {
  const { user } = useAuth();
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  // MFA Setup state
  const [showMfaSetup, setShowMfaSetup] = useState(false);
  const [qrCode, setQrCode] = useState("");
  const [mfaSecret, setMfaSecret] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [setupError, setSetupError] = useState("");
  const [setupLoading, setSetupLoading] = useState(false);

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
