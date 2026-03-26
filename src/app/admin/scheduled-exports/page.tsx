"use client";

import { useState, useEffect, useCallback } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import {
  Plus,
  Pencil,
  Trash2,
  Play,
  CheckCircle,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronUp,
  Mail,
  HardDrive,
  Cloud,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduledExport {
  id: number;
  name: string;
  reportType: string;
  format: string;
  destination: string;
  config: Record<string, string | number | boolean>;
  enabled: boolean;
  frequency: string;
  time: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
}

interface Credential {
  provider: string;
  updatedAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REPORT_TYPES = [
  { value: "trained-not-certified", label: "Trained but Not Certified" },
  { value: "by-product", label: "By Product Type" },
  { value: "by-function", label: "By Function" },
  { value: "expiring-soon", label: "Expiring Soon" },
  { value: "last-12-months", label: "Achieved in Last 12 Months" },
];

const FORMATS = [
  { value: "csv", label: "CSV" },
  { value: "excel", label: "Excel (XLSX)" },
  { value: "pdf", label: "PDF" },
];

const DESTINATIONS = [
  { value: "local", label: "Local Filesystem", icon: HardDrive },
  { value: "email", label: "Email", icon: Mail },
  { value: "google-drive", label: "Google Drive", icon: Cloud },
  { value: "box", label: "Box", icon: Cloud },
  { value: "onedrive", label: "OneDrive", icon: Cloud },
];

const FREQUENCIES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1);

const CREDENTIAL_PROVIDERS = [
  {
    provider: "email",
    label: "Email (SMTP)",
    fields: [
      { key: "host", label: "SMTP Host", type: "text", placeholder: "smtp.example.com" },
      { key: "port", label: "Port", type: "number", placeholder: "587" },
      { key: "secure", label: "Use TLS", type: "checkbox" },
      { key: "user", label: "Username", type: "text", placeholder: "user@example.com" },
      { key: "password", label: "Password", type: "password", placeholder: "" },
      { key: "from", label: "From Address", type: "text", placeholder: "reports@example.com" },
    ],
  },
  {
    provider: "google-drive",
    label: "Google Drive",
    fields: [
      { key: "clientId", label: "Client ID", type: "text", placeholder: "" },
      { key: "clientSecret", label: "Client Secret", type: "password", placeholder: "" },
      { key: "refreshToken", label: "Refresh Token", type: "password", placeholder: "" },
      { key: "folderId", label: "Default Folder ID (optional)", type: "text", placeholder: "" },
    ],
  },
  {
    provider: "box",
    label: "Box",
    fields: [
      { key: "clientId", label: "Client ID", type: "text", placeholder: "" },
      { key: "clientSecret", label: "Client Secret", type: "password", placeholder: "" },
      { key: "accessToken", label: "Access Token", type: "password", placeholder: "" },
      { key: "folderId", label: "Default Folder ID (optional)", type: "text", placeholder: "0" },
    ],
  },
  {
    provider: "onedrive",
    label: "OneDrive",
    fields: [
      { key: "clientId", label: "Azure App Client ID", type: "text", placeholder: "" },
      { key: "tenantId", label: "Tenant ID", type: "text", placeholder: "" },
      { key: "clientSecret", label: "Client Secret", type: "password", placeholder: "" },
    ],
  },
];

// ─── Destination config fields ────────────────────────────────────────────────

function DestinationConfigFields({
  destination,
  config,
  onChange,
}: {
  destination: string;
  config: Record<string, string | number | boolean>;
  onChange: (key: string, value: string | number | boolean) => void;
}) {
  switch (destination) {
    case "local":
      return (
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-gray-600 mb-1">Output Path</label>
            <input
              type="text"
              value={String(config.path ?? "/opt/training-tracker/exports")}
              onChange={(e) => onChange("path", e.target.value)}
              className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-mono"
              placeholder="/opt/training-tracker/exports"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Keep last (0 = unlimited)</label>
            <input
              type="number"
              min="0"
              value={Number(config.retentionCount ?? 0)}
              onChange={(e) => onChange("retentionCount", Number(e.target.value))}
              className="w-24 px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
            />
          </div>
        </div>
      );
    case "email":
      return (
        <div>
          <label className="block text-sm text-gray-600 mb-1">Recipient Email</label>
          <input
            type="email"
            value={String(config.to ?? "")}
            onChange={(e) => onChange("to", e.target.value)}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
            placeholder="recipient@example.com"
          />
          <p className="text-xs text-gray-400 mt-1">SMTP credentials are configured in the Provider Credentials section below.</p>
        </div>
      );
    case "google-drive":
      return (
        <div>
          <label className="block text-sm text-gray-600 mb-1">Folder ID (overrides default)</label>
          <input
            type="text"
            value={String(config.folderId ?? "")}
            onChange={(e) => onChange("folderId", e.target.value)}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-mono"
            placeholder="Leave blank to use default from credentials"
          />
          <p className="text-xs text-gray-400 mt-1">OAuth credentials are configured in the Provider Credentials section below.</p>
        </div>
      );
    case "box":
      return (
        <div>
          <label className="block text-sm text-gray-600 mb-1">Folder ID (overrides default)</label>
          <input
            type="text"
            value={String(config.folderId ?? "")}
            onChange={(e) => onChange("folderId", e.target.value)}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-mono"
            placeholder="0 (root)"
          />
          <p className="text-xs text-gray-400 mt-1">App credentials are configured in the Provider Credentials section below.</p>
        </div>
      );
    case "onedrive":
      return (
        <div>
          <label className="block text-sm text-gray-600 mb-1">Folder Path (optional)</label>
          <input
            type="text"
            value={String(config.folderPath ?? "")}
            onChange={(e) => onChange("folderPath", e.target.value)}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-mono"
            placeholder="Reports/Scheduled"
          />
          <p className="text-xs text-gray-400 mt-1">Azure app credentials are configured in the Provider Credentials section below.</p>
        </div>
      );
    default:
      return null;
  }
}

// ─── Schedule form state ──────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: "",
  reportType: "trained-not-certified",
  format: "csv",
  destination: "local",
  config: {} as Record<string, string | number | boolean>,
  enabled: true,
  frequency: "daily",
  time: "07:00",
  dayOfWeek: 1,
  dayOfMonth: 1,
};

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ScheduledExportsPage() {
  const [schedules, setSchedules] = useState<ScheduledExport[]>([]);
  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credsOpen, setCredsOpen] = useState(false);

  // Schedule modal
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // Delete modal
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Run-now state per row
  const [runningId, setRunningId] = useState<number | null>(null);
  const [runResult, setRunResult] = useState<{ id: number; status: string; error?: string } | null>(null);

  // Credential forms
  const [credForms, setCredForms] = useState<Record<string, Record<string, string | boolean>>>({});
  const [savingCred, setSavingCred] = useState<string | null>(null);
  const [credResult, setCredResult] = useState<{ provider: string; type: "success" | "error"; message: string } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [schedsRes, credsRes] = await Promise.all([
        fetch("/api/admin/scheduled-exports"),
        fetch("/api/admin/scheduled-exports/credentials"),
      ]);
      setSchedules(await schedsRes.json());
      setCredentials(await credsRes.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Schedule CRUD ──────────────────────────────────────────────────────────

  function openAdd() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormError("");
    setShowModal(true);
  }

  function openEdit(s: ScheduledExport) {
    setEditingId(s.id);
    setForm({
      name: s.name,
      reportType: s.reportType,
      format: s.format,
      destination: s.destination,
      config: { ...s.config },
      enabled: s.enabled,
      frequency: s.frequency,
      time: s.time,
      dayOfWeek: s.dayOfWeek ?? 1,
      dayOfMonth: s.dayOfMonth ?? 1,
    });
    setFormError("");
    setShowModal(true);
  }

  async function handleSave() {
    if (!form.name.trim()) { setFormError("Name is required."); return; }
    setSaving(true);
    setFormError("");
    try {
      const payload = {
        ...form,
        dayOfWeek: form.frequency === "weekly" ? form.dayOfWeek : null,
        dayOfMonth: form.frequency === "monthly" ? form.dayOfMonth : null,
      };
      const res = editingId
        ? await fetch(`/api/admin/scheduled-exports/${editingId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/admin/scheduled-exports", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) {
        const d = await res.json();
        setFormError(d.error ?? "Failed to save.");
        return;
      }
      setShowModal(false);
      await loadData();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (deleteId === null) return;
    setDeleting(true);
    try {
      await fetch(`/api/admin/scheduled-exports/${deleteId}`, { method: "DELETE" });
      setDeleteId(null);
      await loadData();
    } finally {
      setDeleting(false);
    }
  }

  async function handleRunNow(id: number) {
    setRunningId(id);
    setRunResult(null);
    try {
      const res = await fetch(`/api/admin/scheduled-exports/${id}/run`, { method: "POST" });
      const data = await res.json();
      setRunResult({ id, ...data });
    } catch {
      setRunResult({ id, status: "error", error: "Request failed" });
    } finally {
      setRunningId(null);
      await loadData();
    }
  }

  async function handleToggleEnabled(s: ScheduledExport) {
    await fetch(`/api/admin/scheduled-exports/${s.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    await loadData();
  }

  // ─── Credentials ────────────────────────────────────────────────────────────

  async function handleSaveCred(provider: string) {
    setSavingCred(provider);
    setCredResult(null);
    try {
      const res = await fetch("/api/admin/scheduled-exports/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, config: credForms[provider] ?? {} }),
      });
      if (res.ok) {
        setCredResult({ provider, type: "success", message: "Credentials saved." });
        await loadData();
      } else {
        setCredResult({ provider, type: "error", message: "Failed to save credentials." });
      }
    } catch {
      setCredResult({ provider, type: "error", message: "Failed to save credentials." });
    } finally {
      setSavingCred(null);
    }
  }

  async function handleDeleteCred(provider: string) {
    await fetch(`/api/admin/scheduled-exports/credentials?provider=${provider}`, { method: "DELETE" });
    setCredResult(null);
    await loadData();
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function labelFor(arr: { value: string; label: string }[], val: string) {
    return arr.find((x) => x.value === val)?.label ?? val;
  }

  function frequencyLabel(s: ScheduledExport) {
    if (s.frequency === "weekly" && s.dayOfWeek !== null)
      return `Weekly (${DAYS_OF_WEEK[s.dayOfWeek]}) at ${s.time}`;
    if (s.frequency === "monthly" && s.dayOfMonth !== null)
      return `Monthly (day ${s.dayOfMonth}) at ${s.time}`;
    return `Daily at ${s.time}`;
  }

  function isCredConfigured(provider: string) {
    return credentials.some((c) => c.provider === provider);
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div>
      <PageHeader title="Scheduled Exports" showBack helpSlug="scheduled-exports" />

      {/* Run result banner */}
      {runResult && (
        <div
          className={`mb-4 flex items-center gap-2 p-3 rounded-lg border text-sm ${
            runResult.status === "success"
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-red-50 border-red-200 text-red-800"
          }`}
        >
          {runResult.status === "success" ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
          {runResult.status === "success"
            ? "Export ran successfully."
            : `Export failed: ${runResult.error}`}
          <button className="ml-auto text-xs underline" onClick={() => setRunResult(null)}>Dismiss</button>
        </div>
      )}

      {/* Schedules table */}
      <section className="bg-white rounded-lg border border-gray-200 mb-6">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">Export Schedules</h2>
          <button
            onClick={openAdd}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={15} />
            Add Schedule
          </button>
        </div>

        {loading ? (
          <p className="px-6 py-8 text-sm text-gray-400">Loading...</p>
        ) : schedules.length === 0 ? (
          <p className="px-6 py-8 text-sm text-gray-400">
            No scheduled exports yet. Click <strong>Add Schedule</strong> to get started.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left bg-gray-50">
                  <th className="px-4 py-3 font-medium text-gray-600">Name</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Report</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Format</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Destination</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Schedule</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Last Run</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} className={`border-b border-gray-50 hover:bg-gray-50 ${!s.enabled ? "opacity-50" : ""}`}>
                    <td className="px-4 py-3 font-medium">{s.name}</td>
                    <td className="px-4 py-3 text-gray-600">{labelFor(REPORT_TYPES, s.reportType)}</td>
                    <td className="px-4 py-3 uppercase text-xs font-mono text-gray-500">{s.format}</td>
                    <td className="px-4 py-3 text-gray-600">{labelFor(DESTINATIONS, s.destination)}</td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{frequencyLabel(s)}</td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {s.lastRunAt
                        ? new Date(s.lastRunAt).toLocaleDateString("en-GB", {
                            day: "numeric", month: "short", year: "numeric",
                            hour: "2-digit", minute: "2-digit",
                          })
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {s.lastStatus === "success" && (
                        <span className="flex items-center gap-1 text-green-600 text-xs">
                          <CheckCircle size={12} /> OK
                        </span>
                      )}
                      {s.lastStatus === "error" && (
                        <span className="flex items-center gap-1 text-red-600 text-xs" title={s.lastError ?? ""}>
                          <AlertTriangle size={12} /> Error
                        </span>
                      )}
                      {!s.lastStatus && <span className="text-gray-400 text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleRunNow(s.id)}
                          disabled={runningId === s.id}
                          title="Run now"
                          className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded disabled:opacity-40"
                        >
                          <Play size={14} />
                        </button>
                        <button
                          onClick={() => handleToggleEnabled(s)}
                          title={s.enabled ? "Disable" : "Enable"}
                          className="p-1.5 text-gray-500 hover:text-amber-600 hover:bg-amber-50 rounded"
                        >
                          <Clock size={14} />
                        </button>
                        <button
                          onClick={() => openEdit(s)}
                          title="Edit"
                          className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => setDeleteId(s.id)}
                          title="Delete"
                          className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded"
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
        )}
      </section>

      {/* Provider Credentials */}
      <section className="bg-white rounded-lg border border-gray-200">
        <button
          onClick={() => setCredsOpen((v) => !v)}
          className="flex items-center justify-between w-full px-6 py-4 text-left"
        >
          <h2 className="font-semibold text-gray-900">Provider Credentials</h2>
          {credsOpen ? <ChevronUp size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
        </button>

        {credsOpen && (
          <div className="border-t border-gray-100 px-6 py-4 space-y-6">
            <p className="text-sm text-gray-500">
              Configure credentials for each delivery provider. Credentials are stored securely in the database and shared across all schedules using that provider.
            </p>

            {CREDENTIAL_PROVIDERS.map((provDef) => {
              const configured = isCredConfigured(provDef.provider);
              const form = credForms[provDef.provider] ?? {};
              const result = credResult?.provider === provDef.provider ? credResult : null;

              return (
                <div key={provDef.provider} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-gray-800">{provDef.label}</h3>
                      {configured ? (
                        <span className="flex items-center gap-1 text-xs text-green-600">
                          <CheckCircle size={12} /> Configured
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">Not configured</span>
                      )}
                    </div>
                    {configured && (
                      <button
                        onClick={() => handleDeleteCred(provDef.provider)}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {provDef.fields.map((field) => (
                      <div key={field.key}>
                        <label className="block text-xs text-gray-500 mb-1">{field.label}</label>
                        {field.type === "checkbox" ? (
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={Boolean(form[field.key] ?? false)}
                              onChange={(e) =>
                                setCredForms((prev) => ({
                                  ...prev,
                                  [provDef.provider]: { ...prev[provDef.provider], [field.key]: e.target.checked },
                                }))
                              }
                              className="w-4 h-4"
                            />
                            <span className="text-sm text-gray-600">Enabled</span>
                          </label>
                        ) : (
                          <input
                            type={field.type}
                            value={String(form[field.key] ?? "")}
                            onChange={(e) =>
                              setCredForms((prev) => ({
                                ...prev,
                                [provDef.provider]: { ...prev[provDef.provider], [field.key]: e.target.value },
                              }))
                            }
                            placeholder={field.placeholder}
                            className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-lg"
                          />
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center gap-3 mt-3">
                    <button
                      onClick={() => handleSaveCred(provDef.provider)}
                      disabled={savingCred === provDef.provider}
                      className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                    >
                      {savingCred === provDef.provider ? "Saving..." : "Save Credentials"}
                    </button>
                    {result && (
                      <span className={`flex items-center gap-1 text-xs ${result.type === "success" ? "text-green-600" : "text-red-600"}`}>
                        {result.type === "success" ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
                        {result.message}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Add / Edit modal */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={editingId ? "Edit Schedule" : "Add Export Schedule"}
        size="lg"
        actions={
          <>
            <button
              onClick={() => setShowModal(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : editingId ? "Save Changes" : "Create Schedule"}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {formError && (
            <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              <AlertTriangle size={14} />
              {formError}
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Schedule Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              placeholder="e.g. Weekly Certification Report"
            />
          </div>

          {/* Report type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Report</label>
            <select
              value={form.reportType}
              onChange={(e) => setForm((f) => ({ ...f, reportType: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              {REPORT_TYPES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          {/* Format */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Format</label>
            <div className="flex gap-2">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, format: f.value }))}
                  className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${
                    form.format === f.value
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-gray-700 border-gray-300 hover:border-blue-300"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Destination */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Destination</label>
            <select
              value={form.destination}
              onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value, config: {} }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              {DESTINATIONS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </div>

          {/* Destination-specific config */}
          <div className="pl-1">
            <DestinationConfigFields
              destination={form.destination}
              config={form.config}
              onChange={(key, val) => setForm((f) => ({ ...f, config: { ...f.config, [key]: val } }))}
            />
          </div>

          {/* Schedule */}
          <div className="border-t border-gray-100 pt-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Schedule</label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Frequency</label>
                <select
                  value={form.frequency}
                  onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value }))}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                >
                  {FREQUENCIES.map((fr) => (
                    <option key={fr.value} value={fr.value}>{fr.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Time</label>
                <input
                  type="time"
                  value={form.time}
                  onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              {form.frequency === "weekly" && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Day of Week</label>
                  <select
                    value={form.dayOfWeek}
                    onChange={(e) => setForm((f) => ({ ...f, dayOfWeek: Number(e.target.value) }))}
                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                  >
                    {DAYS_OF_WEEK.map((d, i) => (
                      <option key={d} value={i}>{d}</option>
                    ))}
                  </select>
                </div>
              )}
              {form.frequency === "monthly" && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Day of Month</label>
                  <select
                    value={form.dayOfMonth}
                    onChange={(e) => setForm((f) => ({ ...f, dayOfMonth: Number(e.target.value) }))}
                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                  >
                    {DAYS_OF_MONTH.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* Enabled */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              className="w-4 h-4 text-blue-600 rounded border-gray-300"
            />
            <span className="text-sm text-gray-700">Enabled</span>
          </label>
        </div>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        title="Delete Schedule"
        actions={
          <>
            <button
              onClick={() => setDeleteId(null)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </>
        }
      >
        <p className="text-gray-600 text-sm">
          Are you sure you want to delete this export schedule? This action cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
