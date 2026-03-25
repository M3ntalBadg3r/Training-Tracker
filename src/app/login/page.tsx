"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          ...(mfaRequired ? { mfaCode } : {}),
        }),
      });

      const data = await res.json();

      if (data.mfaRequired) {
        setMfaRequired(true);
        setLoading(false);
        return;
      }

      if (!res.ok) {
        setError(data.error || "Login failed");
        setLoading(false);
        return;
      }

      router.push("/dashboard");
    } catch (err) {
      console.error("Login fetch error:", err);
      setError("Unable to connect to the server. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-8">
          <div className="flex items-center justify-center gap-3 mb-6">
            <ShieldCheck size={32} className="text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-900">
              Training Tracker
            </h1>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {!mfaRequired ? (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Username
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoFocus
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </>
            ) : (
              <div>
                <p className="text-sm text-gray-600 mb-3">
                  Enter the 6-digit code from your authenticator app.
                </p>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  MFA Code
                </label>
                <input
                  type="text"
                  value={mfaCode}
                  onChange={(e) =>
                    setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  required
                  autoFocus
                  maxLength={6}
                  placeholder="000000"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-center text-2xl tracking-widest"
                />
              </div>
            )}

            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? "Signing in..." : mfaRequired ? "Verify" : "Sign In"}
            </button>

            {mfaRequired && (
              <button
                type="button"
                onClick={() => {
                  setMfaRequired(false);
                  setMfaCode("");
                  setError("");
                }}
                className="w-full py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                Back to login
              </button>
            )}
          </form>
        </div>
        <p className="text-center text-xs text-gray-400 mt-4">
          v{process.env.APP_VERSION}
        </p>
      </div>
    </div>
  );
}
