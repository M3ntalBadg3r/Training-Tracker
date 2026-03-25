"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import {
  Download,
  Upload,
  AlertTriangle,
  CheckCircle,
  Calendar,
  Clock,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  RefreshCw,
  Trash2,
  Undo2,
  HardDrive,
} from "lucide-react";

interface ScheduleConfig {
  enabled: boolean;
  frequency: "daily" | "weekly";
  time: string;
  dayOfWeek?: number;
  backupPath: string;
  retentionCount: number;
}

interface BackupFile {
  name: string;
  size: number;
  created: string;
}

interface BrowseResult {
  currentPath: string;
  parentPath: string | null;
  directories: { name: string; path: string }[];
  writable: boolean;
  error?: string;
}

const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BackupPage() {
  // Manual backup state
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [result, setResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-backup schedule state
  const [schedule, setSchedule] = useState<ScheduleConfig>({
    enabled: false,
    frequency: "daily",
    time: "02:00",
    dayOfWeek: 0,
    backupPath: "/opt/training-tracker/backups",
    retentionCount: 5,
  });
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleResult, setScheduleResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [runningBackup, setRunningBackup] = useState(false);

  // Directory browser state
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserData, setBrowserData] = useState<BrowseResult | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Saved backups state
  const [backupFiles, setBackupFiles] = useState<BackupFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [showServerRestore, setShowServerRestore] = useState(false);
  const [serverRestoreFile, setServerRestoreFile] = useState("");
  const [serverRestoreConfirm, setServerRestoreConfirm] = useState("");
  const [serverRestoring, setServerRestoring] = useState(false);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);

  // Load schedule and files on mount
  useEffect(() => {
    fetch("/api/admin/backup/schedule")
      .then((r) => r.json())
      .then((data) => {
        if (data.enabled !== undefined) setSchedule(data);
      })
      .catch(() => {});
    loadBackupFiles();
  }, []);

  const loadBackupFiles = useCallback(async () => {
    setLoadingFiles(true);
    try {
      const res = await fetch("/api/admin/backup/files");
      const data = await res.json();
      setBackupFiles(data.files || []);
    } catch {
      // Ignore
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  // --- Manual backup handlers ---

  const handleBackup = async () => {
    setCreating(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/backup");
      if (!res.ok) throw new Error("Backup failed");
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="(.+)"/);
      const filename = match?.[1] ?? "training-tracker-backup.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setResult({ type: "success", message: "Backup downloaded successfully." });
    } catch {
      setResult({ type: "error", message: "Failed to create backup." });
    } finally {
      setCreating(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (file && !file.name.endsWith(".zip")) {
      setResult({ type: "error", message: "Please select a .zip backup file." });
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setResult(null);
    if (file) setShowRestoreConfirm(true);
  };

  const handleRestore = async () => {
    if (confirmText !== "RESTORE" || !selectedFile) return;
    setRestoring(true);
    setShowRestoreConfirm(false);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      const res = await fetch("/api/admin/backup", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Restore failed");
      const c = data.counts;
      setResult({
        type: "success",
        message: `Restore complete — ${c.regionData} regions, ${c.trainingData} trainings, ${c.students} students, ${c.trainingTaken} training records restored.`,
      });
    } catch (err) {
      setResult({
        type: "error",
        message: err instanceof Error ? err.message : "Restore failed.",
      });
    } finally {
      setRestoring(false);
      setSelectedFile(null);
      setConfirmText("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // --- Auto-backup handlers ---

  const saveSchedule = async () => {
    setSavingSchedule(true);
    setScheduleResult(null);
    try {
      const res = await fetch("/api/admin/backup/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(schedule),
      });
      if (res.ok) {
        setScheduleResult({ type: "success", message: "Settings saved successfully" });
      } else {
        setScheduleResult({ type: "error", message: "Failed to save settings" });
      }
    } catch {
      setScheduleResult({ type: "error", message: "Failed to save settings" });
    } finally {
      setSavingSchedule(false);
    }
  };

  const runBackupNow = async () => {
    setRunningBackup(true);
    setScheduleResult(null);
    try {
      const res = await fetch("/api/admin/backup/save", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setScheduleResult({
          type: "success",
          message: `Backup saved: ${data.filename}`,
        });
        loadBackupFiles();
      } else {
        setScheduleResult({
          type: "error",
          message: data.error || "Backup failed",
        });
      }
    } catch {
      setScheduleResult({ type: "error", message: "Failed to run backup" });
    } finally {
      setRunningBackup(false);
    }
  };

  // --- Directory browser handlers ---

  const browsePath = async (dirPath: string) => {
    setBrowserLoading(true);
    try {
      const res = await fetch(
        `/api/admin/backup/browse?path=${encodeURIComponent(dirPath)}`
      );
      const data = await res.json();
      setBrowserData(data);
    } catch {
      // Ignore
    } finally {
      setBrowserLoading(false);
    }
  };

  const openBrowser = () => {
    setShowBrowser(true);
    setNewFolderName("");
    browsePath(schedule.backupPath || "/opt/training-tracker/backups");
  };

  const createFolder = async () => {
    if (!newFolderName.trim() || !browserData) return;
    setCreatingFolder(true);
    try {
      const res = await fetch("/api/admin/backup/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: browserData.currentPath,
          name: newFolderName.trim(),
        }),
      });
      if (res.ok) {
        setNewFolderName("");
        browsePath(browserData.currentPath);
      }
    } catch {
      // Ignore
    } finally {
      setCreatingFolder(false);
    }
  };

  const selectFolder = () => {
    if (browserData) {
      setSchedule((s) => ({ ...s, backupPath: browserData.currentPath }));
    }
    setShowBrowser(false);
  };

  // --- Server-side restore handlers ---

  const handleServerRestore = async () => {
    if (serverRestoreConfirm !== "RESTORE" || !serverRestoreFile) return;
    setServerRestoring(true);
    setShowServerRestore(false);
    setResult(null);
    try {
      const res = await fetch("/api/admin/backup/restore-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: serverRestoreFile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Restore failed");
      const c = data.counts;
      setResult({
        type: "success",
        message: `Restore complete — ${c.regionData} regions, ${c.trainingData} trainings, ${c.students} students, ${c.trainingTaken} training records restored.`,
      });
    } catch (err) {
      setResult({
        type: "error",
        message: err instanceof Error ? err.message : "Restore failed.",
      });
    } finally {
      setServerRestoring(false);
      setServerRestoreFile("");
      setServerRestoreConfirm("");
    }
  };

  const deleteBackupFile = async (filename: string) => {
    setDeletingFile(filename);
    try {
      const res = await fetch("/api/admin/backup/files", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      if (res.ok) {
        loadBackupFiles();
      }
    } catch {
      // Ignore
    } finally {
      setDeletingFile(null);
    }
  };

  // --- Breadcrumb segments ---
  const breadcrumbSegments = browserData
    ? browserData.currentPath.split("/").filter(Boolean)
    : [];

  return (
    <div>
      <PageHeader title="Backup &amp; Restore" showBack helpSlug="backup" />

      {/* Status message */}
      {result && (
        <div
          className={`mb-6 flex items-center gap-2 p-4 rounded-lg border ${
            result.type === "success"
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-red-50 border-red-200 text-red-800"
          }`}
        >
          {result.type === "success" ? (
            <CheckCircle size={18} />
          ) : (
            <AlertTriangle size={18} />
          )}
          <span className="text-sm">{result.message}</span>
        </div>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        {/* Backup Card */}
        <section className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Download size={20} className="text-blue-600" />
            </div>
            <h2 className="text-lg font-semibold">Create Backup</h2>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Download a zip file containing all system data: regions, training
            programs, students, and training records. Use this to restore the
            system on a new installation.
          </p>
          <button
            onClick={handleBackup}
            disabled={creating}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <Download size={16} />
            {creating ? "Creating backup..." : "Download Backup"}
          </button>
        </section>

        {/* Restore Card */}
        <section className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-amber-100 rounded-lg">
              <Upload size={20} className="text-amber-600" />
            </div>
            <h2 className="text-lg font-semibold">Restore from File</h2>
          </div>
          <p className="text-sm text-gray-500 mb-2">
            Upload a previously created backup zip to restore all data. This
            will <strong>replace</strong> all existing data in the system.
          </p>
          <p className="text-xs text-amber-600 mb-4 flex items-center gap-1">
            <AlertTriangle size={14} />
            All current data will be overwritten.
          </p>
          <label
            className={`inline-flex items-center gap-2 px-4 py-2 text-sm rounded-lg cursor-pointer ${
              restoring
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-amber-600 text-white hover:bg-amber-700"
            }`}
          >
            <Upload size={16} />
            {restoring ? "Restoring..." : "Upload Backup File"}
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              onChange={handleFileSelect}
              disabled={restoring}
              className="hidden"
            />
          </label>
        </section>
      </div>

      {/* Automatic Backups */}
      <section className="mt-6 p-6 bg-white rounded-lg border border-gray-200">
        <div className="flex items-center gap-2 mb-4">
          <Calendar size={20} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">
            Automatic Backups
          </h2>
        </div>

        <div className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={schedule.enabled}
              onChange={(e) =>
                setSchedule((s) => ({ ...s, enabled: e.target.checked }))
              }
              className="w-4 h-4 text-blue-600 rounded border-gray-300"
            />
            <span className="text-sm text-gray-700">
              Enable automatic backups
            </span>
          </label>

          {schedule.enabled && (
            <div className="ml-7 space-y-3">
              {/* Backup Location */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-24 shrink-0">
                  Location:
                </label>
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="text"
                    value={schedule.backupPath}
                    onChange={(e) =>
                      setSchedule((s) => ({
                        ...s,
                        backupPath: e.target.value,
                      }))
                    }
                    className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-mono"
                  />
                  <button
                    onClick={openBrowser}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    <FolderOpen size={14} />
                    Browse
                  </button>
                </div>
              </div>

              {/* Retention */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-24 shrink-0">
                  Keep last:
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={schedule.retentionCount}
                    onChange={(e) =>
                      setSchedule((s) => ({
                        ...s,
                        retentionCount: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                    className="w-20 px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                  />
                  <span className="text-sm text-gray-500">backups</span>
                </div>
              </div>

              {/* Frequency */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-24 shrink-0">
                  Frequency:
                </label>
                <select
                  value={schedule.frequency}
                  onChange={(e) =>
                    setSchedule((s) => ({
                      ...s,
                      frequency: e.target.value as "daily" | "weekly",
                    }))
                  }
                  className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>

              {schedule.frequency === "weekly" && (
                <div className="flex items-center gap-3">
                  <label className="text-sm text-gray-600 w-24 shrink-0">
                    Day:
                  </label>
                  <select
                    value={schedule.dayOfWeek ?? 0}
                    onChange={(e) =>
                      setSchedule((s) => ({
                        ...s,
                        dayOfWeek: Number(e.target.value),
                      }))
                    }
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                  >
                    {DAYS_OF_WEEK.map((day, i) => (
                      <option key={day} value={i}>
                        {day}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-24 shrink-0">
                  Time:
                </label>
                <div className="flex items-center gap-1">
                  <Clock size={14} className="text-gray-400" />
                  <input
                    type="time"
                    value={schedule.time}
                    onChange={(e) =>
                      setSchedule((s) => ({ ...s, time: e.target.value }))
                    }
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
              </div>

              <p className="text-xs text-gray-400">
                Backups are saved to the configured location. When the number
                of backups exceeds the retention count, the oldest are
                automatically deleted.
              </p>
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={saveSchedule}
              disabled={savingSchedule}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {savingSchedule ? "Saving..." : "Save Settings"}
            </button>

            {schedule.enabled && (
              <button
                onClick={runBackupNow}
                disabled={runningBackup}
                className="flex items-center gap-1.5 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                <HardDrive size={14} />
                {runningBackup ? "Running..." : "Run Backup Now"}
              </button>
            )}

            {scheduleResult && (
              <div
                className={`flex items-center gap-1 text-sm ${
                  scheduleResult.type === "success"
                    ? "text-green-600"
                    : "text-red-600"
                }`}
              >
                {scheduleResult.type === "success" ? (
                  <CheckCircle size={14} />
                ) : (
                  <AlertTriangle size={14} />
                )}
                <span>{scheduleResult.message}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Saved Backups */}
      <section className="mt-6 p-6 bg-white rounded-lg border border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <HardDrive size={20} className="text-gray-600" />
            <h2 className="text-lg font-semibold text-gray-900">
              Saved Backups
            </h2>
            {backupFiles.length > 0 && (
              <span className="text-sm text-gray-400">
                ({backupFiles.length})
              </span>
            )}
          </div>
          <button
            onClick={loadBackupFiles}
            disabled={loadingFiles}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
          >
            <RefreshCw
              size={14}
              className={loadingFiles ? "animate-spin" : ""}
            />
            Refresh
          </button>
        </div>

        {backupFiles.length === 0 ? (
          <p className="text-sm text-gray-500">
            No saved backups found. Configure automatic backups above or use
            &quot;Run Backup Now&quot; to create one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left">
                  <th className="py-2 pr-4 font-medium text-gray-600">
                    Filename
                  </th>
                  <th className="py-2 pr-4 font-medium text-gray-600">Size</th>
                  <th className="py-2 pr-4 font-medium text-gray-600">Date</th>
                  <th className="py-2 font-medium text-gray-600 text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {backupFiles.map((file) => (
                  <tr
                    key={file.name}
                    className="border-b border-gray-100 hover:bg-gray-50"
                  >
                    <td className="py-2 pr-4 font-mono text-xs">
                      {file.name}
                    </td>
                    <td className="py-2 pr-4 text-gray-500">
                      {formatSize(file.size)}
                    </td>
                    <td className="py-2 pr-4 text-gray-500">
                      {new Date(file.created).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => {
                            setServerRestoreFile(file.name);
                            setServerRestoreConfirm("");
                            setShowServerRestore(true);
                          }}
                          disabled={serverRestoring}
                          className="flex items-center gap-1 px-2 py-1 text-xs text-amber-700 border border-amber-300 rounded hover:bg-amber-50 disabled:opacity-50"
                        >
                          <Undo2 size={12} />
                          Restore
                        </button>
                        <button
                          onClick={() => deleteBackupFile(file.name)}
                          disabled={deletingFile === file.name}
                          className="flex items-center gap-1 px-2 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50"
                        >
                          <Trash2 size={12} />
                          {deletingFile === file.name
                            ? "Deleting..."
                            : "Delete"}
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

      {/* Restore Confirmation Modal (file upload) */}
      <Modal
        open={showRestoreConfirm}
        onClose={() => {
          setShowRestoreConfirm(false);
          setConfirmText("");
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
        title="Confirm Restore"
        actions={
          <>
            <button
              onClick={() => {
                setShowRestoreConfirm(false);
                setConfirmText("");
                setSelectedFile(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleRestore}
              disabled={confirmText !== "RESTORE" || restoring}
              className="px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
            >
              {restoring ? "Restoring..." : "Confirm Restore"}
            </button>
          </>
        }
      >
        <p className="text-gray-600 mb-2">
          This will <strong>replace all existing data</strong> with the contents
          of:
        </p>
        <p className="text-sm font-mono bg-gray-100 px-3 py-2 rounded mb-3">
          {selectedFile?.name}
        </p>
        <p className="text-gray-600 mb-3">
          Type <strong>RESTORE</strong> to confirm.
        </p>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="Type RESTORE to confirm"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </Modal>

      {/* Server Restore Confirmation Modal */}
      <Modal
        open={showServerRestore}
        onClose={() => {
          setShowServerRestore(false);
          setServerRestoreFile("");
          setServerRestoreConfirm("");
        }}
        title="Confirm Restore"
        actions={
          <>
            <button
              onClick={() => {
                setShowServerRestore(false);
                setServerRestoreFile("");
                setServerRestoreConfirm("");
              }}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleServerRestore}
              disabled={
                serverRestoreConfirm !== "RESTORE" || serverRestoring
              }
              className="px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
            >
              {serverRestoring ? "Restoring..." : "Confirm Restore"}
            </button>
          </>
        }
      >
        <p className="text-gray-600 mb-2">
          This will <strong>replace all existing data</strong> with the contents
          of:
        </p>
        <p className="text-sm font-mono bg-gray-100 px-3 py-2 rounded mb-3">
          {serverRestoreFile}
        </p>
        <p className="text-gray-600 mb-3">
          Type <strong>RESTORE</strong> to confirm.
        </p>
        <input
          type="text"
          value={serverRestoreConfirm}
          onChange={(e) => setServerRestoreConfirm(e.target.value)}
          placeholder="Type RESTORE to confirm"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </Modal>

      {/* Directory Browser Modal */}
      <Modal
        open={showBrowser}
        onClose={() => setShowBrowser(false)}
        title="Select Backup Folder"
        actions={
          <>
            <button
              onClick={() => setShowBrowser(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={selectFolder}
              disabled={!browserData?.writable}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              Select This Folder
            </button>
          </>
        }
      >
        {browserData && (
          <div>
            {/* Breadcrumb */}
            <div className="flex items-center gap-1 text-sm mb-3 flex-wrap bg-gray-50 p-2 rounded-lg">
              <button
                onClick={() => browsePath("/")}
                className="text-blue-600 hover:underline font-mono"
              >
                /
              </button>
              {breadcrumbSegments.map((seg, i) => {
                const segPath =
                  "/" + breadcrumbSegments.slice(0, i + 1).join("/");
                return (
                  <span key={segPath} className="flex items-center gap-1">
                    <ChevronRight size={12} className="text-gray-400" />
                    <button
                      onClick={() => browsePath(segPath)}
                      className="text-blue-600 hover:underline font-mono"
                    >
                      {seg}
                    </button>
                  </span>
                );
              })}
            </div>

            {/* Writable indicator */}
            <div
              className={`flex items-center gap-1.5 text-xs mb-3 ${
                browserData.writable ? "text-green-600" : "text-red-600"
              }`}
            >
              {browserData.writable ? (
                <CheckCircle size={12} />
              ) : (
                <AlertTriangle size={12} />
              )}
              {browserData.writable
                ? "This folder is writable"
                : "This folder is not writable"}
            </div>

            {/* Error */}
            {browserData.error && (
              <p className="text-xs text-red-500 mb-2">{browserData.error}</p>
            )}

            {/* Directory list */}
            <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg mb-3">
              {browserData.parentPath && (
                <button
                  onClick={() => browsePath(browserData.parentPath!)}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-500 hover:bg-gray-50 border-b border-gray-100"
                >
                  <FolderOpen size={14} />
                  ..
                </button>
              )}
              {browserLoading ? (
                <div className="flex items-center justify-center py-4 text-sm text-gray-400">
                  <RefreshCw size={14} className="animate-spin mr-2" />
                  Loading...
                </div>
              ) : browserData.directories.length === 0 ? (
                <p className="px-3 py-4 text-sm text-gray-400 text-center">
                  No subdirectories
                </p>
              ) : (
                browserData.directories.map((dir) => (
                  <button
                    key={dir.path}
                    onClick={() => browsePath(dir.path)}
                    className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-blue-50 border-b border-gray-100 last:border-0"
                  >
                    <FolderOpen size={14} className="text-blue-500" />
                    {dir.name}
                  </button>
                ))
              )}
            </div>

            {/* Create new folder */}
            <div className="flex items-center gap-2">
              <FolderPlus size={14} className="text-gray-400 shrink-0" />
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="New folder name"
                className="flex-1 px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                onKeyDown={(e) => {
                  if (e.key === "Enter") createFolder();
                }}
              />
              <button
                onClick={createFolder}
                disabled={!newFolderName.trim() || creatingFolder}
                className="px-3 py-1.5 text-sm bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
