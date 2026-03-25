"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import PageHeader from "@/components/layout/PageHeader";
import {
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  Download,
  Clock,
  Calendar,
  FileText,
  ChevronDown,
  ChevronRight,
  Undo2,
} from "lucide-react";

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseName?: string;
  releaseNotes?: string;
  publishedAt?: string;
  htmlUrl?: string;
  message?: string;
  error?: string;
}

interface UpdateStatus {
  step?: number;
  totalSteps?: number;
  message?: string;
  status: "idle" | "in_progress" | "complete" | "error";
  newVersion?: string;
  previousVersion?: string;
  error?: string;
  rolledBack?: boolean;
}

interface ScheduleConfig {
  enabled: boolean;
  frequency: "daily" | "weekly";
  time: string;
  dayOfWeek?: number;
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

export default function UpdatesPage() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    status: "idle",
  });
  const [schedule, setSchedule] = useState<ScheduleConfig>({
    enabled: false,
    frequency: "daily",
    time: "03:00",
    dayOfWeek: 0,
  });
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleResult, setScheduleResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [updateLog, setUpdateLog] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [loadingLog, setLoadingLog] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentVersion = process.env.APP_VERSION || "0.0";

  // Load schedule on mount
  useEffect(() => {
    fetch("/api/admin/updates/schedule")
      .then((r) => r.json())
      .then((data) => {
        if (data.enabled !== undefined) setSchedule(data);
      })
      .catch(() => {});
  }, []);

  // Poll update status
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/admin/updates/status");
        if (!res.ok) return;
        const data: UpdateStatus = await res.json();
        setUpdateStatus(data);
        if (data.status === "complete" || data.status === "error") {
          stopPolling();
          // Auto-load log on error
          if (data.status === "error") {
            fetchUpdateLog();
          }
        }
      } catch {
        // Server may be restarting during update — keep polling
      }
    }, 2000);
  }, [stopPolling]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const checkForUpdates = async () => {
    setChecking(true);
    setUpdateInfo(null);
    try {
      const res = await fetch("/api/admin/updates/check");
      const data = await res.json();
      setUpdateInfo(data);
    } catch {
      setUpdateInfo({
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        error: "Failed to check for updates",
      });
    } finally {
      setChecking(false);
    }
  };

  const applyUpdate = async () => {
    setUpdateStatus({
      step: 0,
      totalSteps: 8,
      message: "Starting update...",
      status: "in_progress",
    });
    setUpdateLog(null);
    setLogOpen(false);
    try {
      const res = await fetch("/api/admin/updates/apply", { method: "POST" });
      if (res.ok) {
        startPolling();
      } else {
        setUpdateStatus({
          status: "error",
          message: "Failed to start update",
          error: "Server returned an error",
        });
      }
    } catch {
      setUpdateStatus({
        status: "error",
        message: "Failed to start update",
        error: "Could not connect to server",
      });
    }
  };

  const fetchUpdateLog = async () => {
    setLoadingLog(true);
    try {
      const res = await fetch("/api/admin/updates/log");
      const data = await res.json();
      if (data.log) {
        setUpdateLog(data.log);
        setLogOpen(true);
      }
    } catch {
      // Ignore
    } finally {
      setLoadingLog(false);
    }
  };

  const saveSchedule = async () => {
    setSavingSchedule(true);
    setScheduleResult(null);
    try {
      const res = await fetch("/api/admin/updates/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(schedule),
      });
      if (res.ok) {
        setScheduleResult({
          type: "success",
          message: "Schedule saved successfully",
        });
      } else {
        setScheduleResult({
          type: "error",
          message: "Failed to save schedule",
        });
      }
    } catch {
      setScheduleResult({
        type: "error",
        message: "Failed to save schedule",
      });
    } finally {
      setSavingSchedule(false);
    }
  };

  const progressPercent =
    updateStatus.step && updateStatus.totalSteps
      ? Math.round((updateStatus.step / updateStatus.totalSteps) * 100)
      : 0;

  return (
    <div>
      <PageHeader title="Updates" showBack helpSlug="updates" />

      {/* Current Version */}
      <section className="mb-6 p-6 bg-white rounded-lg border border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Current Version
            </h2>
            <p className="text-3xl font-bold text-blue-600 mt-1">
              v{currentVersion}
            </p>
          </div>
          <button
            onClick={checkForUpdates}
            disabled={checking || updateStatus.status === "in_progress"}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <RefreshCw
              size={16}
              className={checking ? "animate-spin" : ""}
            />
            {checking ? "Checking..." : "Check for Updates"}
          </button>
        </div>
      </section>

      {/* Update Available / Up to Date */}
      {updateInfo && (
        <section className="mb-6 p-6 bg-white rounded-lg border border-gray-200">
          {updateInfo.error ? (
            <div className="flex items-center gap-2 text-amber-700">
              <AlertTriangle size={18} />
              <span className="text-sm">{updateInfo.error}</span>
            </div>
          ) : updateInfo.updateAvailable ? (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Download size={20} className="text-green-600" />
                <h2 className="text-lg font-semibold text-gray-900">
                  Update Available
                </h2>
                <span className="px-2 py-0.5 text-sm font-medium bg-green-100 text-green-700 rounded-full">
                  v{updateInfo.latestVersion}
                </span>
              </div>

              {updateInfo.releaseName && (
                <h3 className="font-medium text-gray-800 mb-2">
                  {updateInfo.releaseName}
                </h3>
              )}

              {updateInfo.publishedAt && (
                <p className="text-sm text-gray-500 mb-3">
                  Released{" "}
                  {new Date(updateInfo.publishedAt).toLocaleDateString(
                    "en-GB",
                    { day: "numeric", month: "short", year: "numeric" }
                  )}
                </p>
              )}

              {updateInfo.releaseNotes && (
                <div className="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-100">
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">
                    Release Notes
                  </h4>
                  <div className="text-sm text-gray-600 whitespace-pre-wrap">
                    {updateInfo.releaseNotes}
                  </div>
                </div>
              )}

              {updateInfo.htmlUrl && (
                <a
                  href={updateInfo.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline mb-4 inline-block"
                >
                  View on GitHub
                </a>
              )}

              <div className="mt-4">
                <button
                  onClick={applyUpdate}
                  disabled={updateStatus.status === "in_progress"}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
                >
                  <Download size={16} />
                  Update Now
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-green-700">
              <CheckCircle size={18} />
              <span className="text-sm font-medium">
                {updateInfo.message === "No releases found"
                  ? "No releases found on GitHub"
                  : "You are running the latest version"}
              </span>
            </div>
          )}
        </section>
      )}

      {/* Update Progress */}
      {updateStatus.status !== "idle" && (
        <section className="mb-6 p-6 bg-white rounded-lg border border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Update Progress
          </h2>

          {updateStatus.status === "in_progress" && (
            <>
              <div className="mb-3">
                <div className="flex justify-between text-sm text-gray-600 mb-1">
                  <span>{updateStatus.message}</span>
                  <span>
                    Step {updateStatus.step}/{updateStatus.totalSteps}
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div
                    className="bg-blue-600 h-3 rounded-full transition-all duration-500"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
              <p className="text-xs text-gray-400">
                Do not close this page while the update is in progress.
              </p>
            </>
          )}

          {updateStatus.status === "complete" && (
            <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
              <CheckCircle
                size={20}
                className="text-green-600 shrink-0 mt-0.5"
              />
              <div>
                <p className="font-medium text-green-800">
                  Update completed successfully
                </p>
                {updateStatus.newVersion && (
                  <p className="text-sm text-green-700 mt-1">
                    Updated to v{updateStatus.newVersion}
                    {updateStatus.previousVersion &&
                      ` (from v${updateStatus.previousVersion})`}
                  </p>
                )}
                <p className="text-sm text-green-600 mt-2">
                  Refresh the page to load the new version.
                </p>
              </div>
            </div>
          )}

          {updateStatus.status === "error" && (
            <div>
              <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
                <AlertTriangle
                  size={20}
                  className="text-red-600 shrink-0 mt-0.5"
                />
                <div className="flex-1">
                  <p className="font-medium text-red-800">
                    {updateStatus.message || "Update failed"}
                  </p>
                  {updateStatus.rolledBack && (
                    <div className="flex items-center gap-1.5 mt-2 text-sm text-amber-700">
                      <Undo2 size={14} />
                      <span>
                        The system was automatically rolled back to the
                        previous working version.
                      </span>
                    </div>
                  )}
                  {updateStatus.error && (
                    <p className="text-sm text-red-600 mt-2 font-mono whitespace-pre-wrap">
                      {updateStatus.error}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Update Log */}
      <section className="mb-6 p-6 bg-white rounded-lg border border-gray-200">
        <button
          onClick={() => {
            if (!logOpen && !updateLog) fetchUpdateLog();
            else setLogOpen(!logOpen);
          }}
          className="flex items-center gap-2 w-full text-left"
        >
          {logOpen ? (
            <ChevronDown size={18} className="text-gray-500" />
          ) : (
            <ChevronRight size={18} className="text-gray-500" />
          )}
          <FileText size={18} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">Update Log</h2>
          {loadingLog && (
            <RefreshCw size={14} className="animate-spin text-gray-400" />
          )}
        </button>

        {logOpen && (
          <div className="mt-4">
            {updateLog ? (
              <pre className="p-4 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-700 font-mono whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto">
                {updateLog}
              </pre>
            ) : (
              <p className="text-sm text-gray-500">
                No update log available. A log is created each time an update
                is performed.
              </p>
            )}
            <button
              onClick={fetchUpdateLog}
              disabled={loadingLog}
              className="mt-2 text-sm text-blue-600 hover:underline"
            >
              Refresh log
            </button>
          </div>
        )}
      </section>

      {/* Automatic Updates */}
      <section className="p-6 bg-white rounded-lg border border-gray-200">
        <div className="flex items-center gap-2 mb-4">
          <Calendar size={20} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">
            Automatic Updates
          </h2>
        </div>

        <div className="space-y-4">
          {/* Enable toggle */}
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
              Enable automatic updates
            </span>
          </label>

          {schedule.enabled && (
            <div className="ml-7 space-y-3">
              {/* Frequency */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-20">
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

              {/* Day of week (weekly only) */}
              {schedule.frequency === "weekly" && (
                <div className="flex items-center gap-3">
                  <label className="text-sm text-gray-600 w-20">Day:</label>
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

              {/* Time */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-20">Time:</label>
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
                The system will automatically check for and apply updates at
                the scheduled time. If an update fails, it will be rolled back
                automatically.
              </p>
            </div>
          )}

          {/* Save button */}
          <div className="flex items-center gap-3">
            <button
              onClick={saveSchedule}
              disabled={savingSchedule}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {savingSchedule ? "Saving..." : "Save Schedule"}
            </button>

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
    </div>
  );
}
