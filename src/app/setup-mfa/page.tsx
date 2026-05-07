"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";

export default function SetupMfaPage() {
  const router = useRouter();
  const [qrCode, setQrCode] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(true);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    const start = async () => {
      try {
        const res = await fetch("/api/auth/mfa/setup", { method: "POST" });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Failed to start MFA setup");
          setStarting(false);
          return;
        }
        setQrCode(data.qrCode);
        setSecret(data.secret);
      } catch {
        setError("Unable to connect to the server.");
      } finally {
        setStarting(false);
      }
    };
    void start();
  }, []);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setVerifying(true);
    try {
      const res = await fetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Verification failed");
        setVerifying(false);
        return;
      }
      router.push("/dashboard");
    } catch {
      setError("Unable to connect to the server.");
      setVerifying(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-8">
          <div className="flex items-center justify-center gap-3 mb-2">
            <ShieldCheck size={32} className="text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-900">
              Set Up Multi-Factor Authentication
            </h1>
          </div>
          <p className="text-sm text-gray-500 text-center mb-6">
            An administrator has required MFA on this account before you can
            continue. Scan the QR code with your authenticator app and enter
            the 6-digit code to finish.
          </p>

          {starting ? (
            <p className="text-center text-sm text-gray-500">
              Generating your authenticator key…
            </p>
          ) : qrCode ? (
            <form onSubmit={handleVerify} className="space-y-4">
              <div className="flex justify-center">
                <img src={qrCode} alt="MFA QR Code" className="w-48 h-48" />
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">
                  Or enter this key manually:
                </p>
                <code className="block text-xs bg-gray-100 p-2 rounded text-center font-mono break-all select-all">
                  {secret}
                </code>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Enter the 6-digit code
                </label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder="000000"
                  maxLength={6}
                  autoFocus
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-center text-2xl tracking-widest font-mono"
                />
              </div>
              {error && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={verifying || code.length !== 6}
                className="w-full py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {verifying ? "Verifying…" : "Verify & Continue"}
              </button>
            </form>
          ) : (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
              {error || "Failed to start MFA setup."}
            </div>
          )}

          <button
            type="button"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              router.push("/login");
            }}
            className="w-full mt-4 py-2 text-sm text-gray-600 hover:text-gray-900"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
