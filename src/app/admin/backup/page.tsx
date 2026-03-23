"use client";

import { useState, useRef } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { Download, Upload, AlertTriangle, CheckCircle } from "lucide-react";

export default function BackupPage() {
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
    if (file) {
      setShowRestoreConfirm(true);
    }
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
            <h2 className="text-lg font-semibold">Restore from Backup</h2>
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

      {/* Restore Confirmation Modal */}
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
    </div>
  );
}
