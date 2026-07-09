"use client";

import { useEffect, useState } from "react";
import { Save, CheckCircle } from "lucide-react";

const MIN_MINUTES = 5;
const MAX_MINUTES = 1440;

export default function SessionSection() {
  const [minutes, setMinutes] = useState<number>(30);
  const [original, setOriginal] = useState<number>(30);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/system-settings");
        if (!res.ok) {
          setError("Failed to load system settings");
          return;
        }
        const data = await res.json();
        if (typeof data?.sessionIdleMinutes === "number") {
          setMinutes(data.sessionIdleMinutes);
          setOriginal(data.sessionIdleMinutes);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/system-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIdleMinutes: minutes }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to save");
        return;
      }
      const data = await res.json().catch(() => ({}));
      const saved = typeof data?.sessionIdleMinutes === "number" ? data.sessionIdleMinutes : minutes;
      setMinutes(saved);
      setOriginal(saved);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading system settings...</div>
      </div>
    );
  }

  const invalid =
    !Number.isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES;
  const dirty = minutes !== original;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-2">Session Timeout</h2>
      <p className="text-sm text-gray-500 mb-4">
        How long a signed-in user can be inactive before being automatically signed
        out. A warning appears shortly before the timeout so active users can stay
        signed in. Active users are kept signed in as they work. A fixed absolute cap
        (8 hours by default) still applies regardless of activity. Changes take effect
        the next time a user signs in.
      </p>

      <label className="block text-sm font-medium text-gray-900 mb-1">
        Idle timeout (minutes)
      </label>
      <input
        type="number"
        min={MIN_MINUTES}
        max={MAX_MINUTES}
        value={Number.isFinite(minutes) ? minutes : ""}
        onChange={(e) => setMinutes(parseInt(e.target.value, 10))}
        className="w-40 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <p className="text-xs text-gray-500 mt-1">
        Between {MIN_MINUTES} and {MAX_MINUTES} minutes (24 hours).
      </p>

      {error && (
        <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
          {error}
        </div>
      )}
      {saved && (
        <div className="mt-4 flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-2">
          <CheckCircle size={14} /> Saved.
        </div>
      )}

      <div className="mt-6 flex gap-3">
        <button
          onClick={handleSave}
          disabled={!dirty || invalid || saving}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Save size={14} />
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
