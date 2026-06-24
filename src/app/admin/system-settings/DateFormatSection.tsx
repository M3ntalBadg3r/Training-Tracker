"use client";

import { useEffect, useState } from "react";
import { Save, CheckCircle } from "lucide-react";
import { DATE_FORMATS, type DateFormat, formatDateWith } from "@/lib/date-format";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";

export default function DateFormatSection() {
  const { setSystemFormat } = useDateFormat();
  const [dateFormat, setDateFormat] = useState<DateFormat>("DD/MM/YYYY");
  const [original, setOriginal] = useState<DateFormat>("DD/MM/YYYY");
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
        if (data?.dateFormat === "DD/MM/YYYY" || data?.dateFormat === "MM/DD/YYYY") {
          setDateFormat(data.dateFormat);
          setOriginal(data.dateFormat);
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
        body: JSON.stringify({ dateFormat }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to save");
        return;
      }
      setOriginal(dateFormat);
      setSystemFormat(dateFormat);
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

  const sampleDate = new Date(Date.UTC(2026, 4, 27));
  const dirty = dateFormat !== original;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-2">Default Date Format</h2>
      <p className="text-sm text-gray-500 mb-4">
        Controls how dates are parsed during CSV / Excel imports and how dates are
        displayed throughout the app for users who haven&apos;t set their own preference.
        Individual users can override the display format on their Account page.
      </p>

      <div className="space-y-2">
        {DATE_FORMATS.map((opt) => (
          <label
            key={opt}
            className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
              dateFormat === opt
                ? "border-blue-500 bg-blue-50"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <input
              type="radio"
              name="dateFormat"
              value={opt}
              checked={dateFormat === opt}
              onChange={() => setDateFormat(opt)}
              className="text-blue-600"
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-gray-900">{opt}</div>
              <div className="text-xs text-gray-500">
                Example: {formatDateWith(sampleDate, opt)}
              </div>
            </div>
          </label>
        ))}
      </div>

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
          disabled={!dirty || saving}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Save size={14} />
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
