"use client";

import { useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import {
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Search,
  CheckCircle,
  CalendarClock,
} from "lucide-react";
import { formatDate, trainingTypeLabel } from "@/lib/utils";

interface StudentIssue {
  email: string;
  fullName: string;
  issues: string[];
  suggestedName: string;
}

interface FutureDateRow {
  id: number;
  email: string;
  fullName: string;
  trainingTitle: string;
  fullTitle: string;
  trainingType: string;
  completedDate: string;
  expiryDate: string;
}

interface FutureDatesResponse {
  items: FutureDateRow[];
  today: string;
}

function addTwoYearsIso(iso: string): string {
  // iso is "YYYY-MM-DD". Mirror computeExpiryDate (date-fns addYears) for preview.
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return "";
  const dt = new Date(y, m - 1, d);
  dt.setFullYear(dt.getFullYear() + 2);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

const ISSUE_LABELS: Record<string, { label: string; color: string }> = {
  leading_trailing_spaces: { label: "Spaces", color: "bg-yellow-100 text-yellow-800" },
  email_as_name: { label: "Email as Name", color: "bg-purple-100 text-purple-800" },
  question_marks: { label: "Question Marks", color: "bg-violet-100 text-violet-800" },
  duplicate_name: { label: "Duplicate Name", color: "bg-cyan-100 text-cyan-800" },
  numbers: { label: "Numbers", color: "bg-orange-100 text-orange-800" },
  special_characters: { label: "Special Characters", color: "bg-red-100 text-red-800" },
};

function HighlightedName({ fullName, issues }: { fullName: string; issues: string[] }) {
  if (issues.includes("email_as_name")) {
    return <span className="bg-purple-100 text-purple-800 px-1 rounded">{fullName}</span>;
  }

  // Compute character index ranges that belong to duplicate words (letter-run based,
  // matching backend normalisation that ignores periods/digits/special chars).
  const duplicateRanges: Array<[number, number]> = [];
  if (issues.includes("duplicate_name")) {
    const seen = new Set<string>();
    for (const match of fullName.matchAll(/\p{L}+/gu)) {
      const word = match[0].toLowerCase();
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (seen.has(word)) {
        duplicateRanges.push([start, end]);
      } else {
        seen.add(word);
      }
    }
  }
  const isInDuplicateRange = (idx: number) =>
    duplicateRanges.some(([s, e]) => idx >= s && idx < e);

  // Build highlighted characters
  const chars = fullName.split("");
  return (
    <span>
      {chars.map((ch, i) => {
        const isLeadingSpace = issues.includes("leading_trailing_spaces") && i < fullName.length - fullName.trimStart().length;
        const isTrailingSpace = issues.includes("leading_trailing_spaces") && i >= fullName.trimEnd().length;
        const isNumber = issues.includes("numbers") && /[0-9]/.test(ch);
        const isSpecial = issues.includes("special_characters") && /[^\p{L}\s\-'\d]/u.test(ch);
        const isDup = isInDuplicateRange(i);

        if (isLeadingSpace || isTrailingSpace) {
          return <span key={i} className="bg-yellow-200 text-yellow-900 px-0.5 rounded" title="Leading/trailing space">&middot;</span>;
        }
        if (isNumber) {
          return <span key={i} className="bg-orange-200 text-orange-900 px-0.5 rounded font-bold">{ch}</span>;
        }
        if (isSpecial) {
          return <span key={i} className="bg-red-200 text-red-900 px-0.5 rounded font-bold">{ch}</span>;
        }
        if (isDup) {
          return <span key={i} className="bg-cyan-200 text-cyan-900 px-0.5 rounded font-bold" title="Duplicate word">{ch}</span>;
        }
        return <span key={i}>{ch}</span>;
      })}
    </span>
  );
}

export default function DataCleanUpPage() {
  // Student data scan
  const [studentOpen, setStudentOpen] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [results, setResults] = useState<StudentIssue[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<{ count: number } | null>(null);

  // Future completion dates scan
  const [futureOpen, setFutureOpen] = useState(true);
  const [futureScanning, setFutureScanning] = useState(false);
  const [futureScanned, setFutureScanned] = useState(false);
  const [futureRows, setFutureRows] = useState<FutureDateRow[]>([]);
  const [futureToday, setFutureToday] = useState<string>("");
  const [pendingDates, setPendingDates] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<Record<number, string>>({});

  // Wipe data
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [wipeText, setWipeText] = useState("");
  const [wiping, setWiping] = useState(false);

  const handleScan = async () => {
    setScanning(true);
    setFixResult(null);
    try {
      const res = await fetch("/api/admin/cleanup");
      if (res.ok) {
        const data: StudentIssue[] = await res.json();
        setResults(data);
        setSelected(new Set());
        setScanned(true);
      }
    } finally {
      setScanning(false);
    }
  };

  const handleFix = async () => {
    if (selected.size === 0) return;
    setFixing(true);
    try {
      const updates = results
        .filter((r) => selected.has(r.email))
        .map((r) => ({ email: r.email, fullName: r.suggestedName }));
      const res = await fetch("/api/admin/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      if (res.ok) {
        const data = await res.json();
        setFixResult({ count: data.fixedCount });
        // Re-scan to refresh
        await handleScan();
      }
    } finally {
      setFixing(false);
    }
  };

  const updateSuggestedName = (email: string, value: string) => {
    setResults((prev) =>
      prev.map((r) => (r.email === email ? { ...r, suggestedName: value } : r))
    );
  };

  const toggleAll = () => {
    if (selected.size === results.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(results.map((r) => r.email)));
    }
  };

  const toggleOne = (email: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) {
        next.delete(email);
      } else {
        next.add(email);
      }
      return next;
    });
  };

  const handleFutureScan = async () => {
    setFutureScanning(true);
    setRowError({});
    try {
      const res = await fetch("/api/admin/cleanup/future-dates");
      if (res.ok) {
        const data: FutureDatesResponse = await res.json();
        setFutureRows(data.items);
        setFutureToday(data.today);
        setPendingDates(
          Object.fromEntries(data.items.map((r) => [r.id, r.completedDate]))
        );
        setFutureScanned(true);
      }
    } finally {
      setFutureScanning(false);
    }
  };

  const handleFutureSave = async (row: FutureDateRow) => {
    const newDate = pendingDates[row.id];
    if (!newDate || newDate === row.completedDate) return;
    setSavingId(row.id);
    setRowError((prev) => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
    try {
      const res = await fetch(`/api/training-taken/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completedDate: newDate }),
      });
      if (!res.ok) {
        let msg = "Save failed";
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {}
        setRowError((prev) => ({ ...prev, [row.id]: msg }));
        return;
      }
      // Remove row from the list — it's no longer "future" (or at least has been resolved by the user).
      setFutureRows((prev) => prev.filter((r) => r.id !== row.id));
      setPendingDates((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    } finally {
      setSavingId(null);
    }
  };

  const handleWipe = async () => {
    if (wipeText !== "WIPE") return;
    setWiping(true);
    try {
      await fetch("/api/admin/wipe", { method: "POST" });
      setShowWipeConfirm(false);
      setWipeText("");
      // Clear scan results since data is gone
      setResults([]);
      setSelected(new Set());
      setScanned(false);
    } finally {
      setWiping(false);
    }
  };

  return (
    <div>
      <PageHeader title="Data Clean-Up" helpSlug="data-cleanup" />

      {/* Student Data Clean-Up */}
      <section className="mb-8">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setStudentOpen((prev) => !prev)}
            className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-gray-50 transition-colors"
          >
            {studentOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Student Data</h2>
              <p className="text-sm text-gray-500">Scan for issues in student names</p>
            </div>
            {scanned && (
              <span className="ml-auto text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
                {results.length} issue{results.length !== 1 ? "s" : ""} found
              </span>
            )}
          </button>

          {studentOpen && (
            <div className="border-t border-gray-200 px-6 py-4">
              <div className="flex items-center gap-3 mb-4">
                <button
                  onClick={handleScan}
                  disabled={scanning}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  <Search size={16} />
                  {scanning ? "Scanning..." : "Scan for Issues"}
                </button>

                {scanned && results.length > 0 && (
                  <>
                    <button
                      onClick={toggleAll}
                      className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
                    >
                      {selected.size === results.length ? "Deselect All" : "Select All"}
                    </button>
                    <button
                      onClick={handleFix}
                      disabled={fixing || selected.size === 0}
                      className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                    >
                      {fixing ? "Fixing..." : `Fix Selected (${selected.size})`}
                    </button>
                  </>
                )}
              </div>

              {scanned && results.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <span className="text-sm text-gray-500">Select by issue:</span>
                  {Object.entries(ISSUE_LABELS).map(([key, meta]) => {
                    const emailsWithIssue = results.filter((r) => r.issues.includes(key)).map((r) => r.email);
                    if (emailsWithIssue.length === 0) return null;
                    const allSelected = emailsWithIssue.every((e) => selected.has(e));
                    return (
                      <button
                        key={key}
                        onClick={() => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (allSelected) {
                              emailsWithIssue.forEach((e) => next.delete(e));
                            } else {
                              emailsWithIssue.forEach((e) => next.add(e));
                            }
                            return next;
                          });
                        }}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                          allSelected
                            ? meta.color + " border-current"
                            : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                        }`}
                      >
                        {allSelected ? "✓ " : ""}{meta.label} ({emailsWithIssue.length})
                      </button>
                    );
                  })}
                </div>
              )}

              {fixResult && (
                <div className="flex items-center gap-2 mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                  <CheckCircle size={16} />
                  Fixed {fixResult.count} record{fixResult.count !== 1 ? "s" : ""}.
                </div>
              )}

              {scanned && results.length === 0 && (
                <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                  <CheckCircle size={16} />
                  No issues found. All student names look clean.
                </div>
              )}

              {scanned && results.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b">
                        <th className="px-4 py-3 text-left font-semibold">Full Name</th>
                        <th className="px-4 py-3 text-left font-semibold">Email</th>
                        <th className="px-4 py-3 text-left font-semibold">Issues</th>
                        <th className="px-4 py-3 text-left font-semibold">Suggested Fix</th>
                        <th className="px-4 py-3 text-center font-semibold">Fix</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((row) => (
                        <tr key={row.email} className="border-b hover:bg-gray-50">
                          <td className="px-4 py-3 font-mono text-sm">
                            <HighlightedName fullName={row.fullName} issues={row.issues} />
                          </td>
                          <td className="px-4 py-3 text-gray-600">{row.email}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {row.issues.map((issue) => {
                                const meta = ISSUE_LABELS[issue];
                                return (
                                  <span
                                    key={issue}
                                    className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${meta?.color || "bg-gray-100 text-gray-800"}`}
                                  >
                                    {meta?.label || issue}
                                  </span>
                                );
                              })}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <input
                              type="text"
                              value={row.suggestedName}
                              onChange={(e) => updateSuggestedName(row.email, e.target.value)}
                              className="w-full px-2 py-1 text-sm font-medium text-green-700 bg-green-50 border border-green-200 rounded focus:bg-white focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
                              aria-label={`Suggested name for ${row.email}`}
                            />
                          </td>
                          <td className="px-4 py-3 text-center">
                            <input
                              type="checkbox"
                              checked={selected.has(row.email)}
                              onChange={() => toggleOne(row.email)}
                              className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Future Completion Dates */}
      <section className="mb-8">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setFutureOpen((prev) => !prev)}
            className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-gray-50 transition-colors"
          >
            {futureOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Future Completion Dates</h2>
              <p className="text-sm text-gray-500">
                Find training records whose completed date is after today
              </p>
            </div>
            {futureScanned && (
              <span className="ml-auto text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
                {futureRows.length} record{futureRows.length !== 1 ? "s" : ""} found
              </span>
            )}
          </button>

          {futureOpen && (
            <div className="border-t border-gray-200 px-6 py-4">
              <div className="flex items-center gap-3 mb-4">
                <button
                  onClick={handleFutureScan}
                  disabled={futureScanning}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  <Search size={16} />
                  {futureScanning ? "Scanning..." : "Scan for Issues"}
                </button>
                {futureScanned && futureToday && (
                  <span className="text-sm text-gray-500 flex items-center gap-1.5">
                    <CalendarClock size={14} />
                    Today is {formatDate(futureToday)} — flagging any completed date after this.
                  </span>
                )}
              </div>

              {futureScanned && futureRows.length === 0 && (
                <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                  <CheckCircle size={16} />
                  No records with a future completed date.
                </div>
              )}

              {futureScanned && futureRows.length > 0 && (
                <>
                  <p className="text-sm text-gray-600 mb-3">
                    Each completed date below is editable. Saving updates the record
                    immediately and recomputes the expiry as completed + 2 years. No automated
                    fix is applied — choose the correct date for each row.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 border-b">
                          <th className="px-4 py-3 text-left font-semibold">Student</th>
                          <th className="px-4 py-3 text-left font-semibold">Training</th>
                          <th className="px-4 py-3 text-left font-semibold">Completed Date</th>
                          <th className="px-4 py-3 text-left font-semibold">Expiry (preview)</th>
                          <th className="px-4 py-3 text-left font-semibold">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {futureRows.map((row) => {
                          const current = pendingDates[row.id] ?? row.completedDate;
                          const isFuture = !!futureToday && current > futureToday;
                          const isDirty = current !== row.completedDate;
                          const previewExpiry = current ? addTwoYearsIso(current) : "";
                          const err = rowError[row.id];
                          return (
                            <tr key={row.id} className="border-b hover:bg-gray-50 align-top">
                              <td className="px-4 py-3">
                                <div className="font-medium text-gray-900">{row.fullName}</div>
                                <div className="text-xs text-gray-500">{row.email}</div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="text-gray-900">{row.fullTitle}</div>
                                <div className="text-xs text-gray-500">
                                  {trainingTypeLabel(row.trainingType)}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <input
                                  type="date"
                                  value={current}
                                  onChange={(e) =>
                                    setPendingDates((prev) => ({
                                      ...prev,
                                      [row.id]: e.target.value,
                                    }))
                                  }
                                  className={`px-2 py-1 text-sm rounded border focus:outline-none focus:ring-2 ${
                                    isFuture
                                      ? "bg-amber-50 border-amber-400 text-amber-900 ring-1 ring-amber-300 focus:ring-amber-500"
                                      : "bg-white border-gray-300 focus:ring-blue-500"
                                  }`}
                                  aria-label={`Completed date for ${row.fullName} / ${row.fullTitle}`}
                                />
                                {isFuture && (
                                  <div className="text-xs text-amber-700 mt-1">
                                    Future date
                                  </div>
                                )}
                                {err && (
                                  <div className="text-xs text-red-600 mt-1">{err}</div>
                                )}
                              </td>
                              <td className="px-4 py-3 text-gray-600">
                                {previewExpiry ? formatDate(previewExpiry) : "—"}
                              </td>
                              <td className="px-4 py-3">
                                <button
                                  onClick={() => handleFutureSave(row)}
                                  disabled={!isDirty || savingId === row.id}
                                  className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                                >
                                  {savingId === row.id ? "Saving..." : "Save"}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Danger Zone */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">Danger Zone</h2>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle size={24} className="text-red-500 shrink-0" />
            <div>
              <h3 className="font-semibold text-red-800">Wipe All Data</h3>
              <p className="text-sm text-red-600 mt-1">
                This will permanently delete all students, training records,
                training data, and region data. This action cannot be undone.
              </p>
              <button
                onClick={() => setShowWipeConfirm(true)}
                className="mt-3 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Wipe All Data
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Wipe Confirmation Modal */}
      <Modal
        open={showWipeConfirm}
        onClose={() => {
          setShowWipeConfirm(false);
          setWipeText("");
        }}
        title="Confirm Data Wipe"
        actions={
          <>
            <button
              onClick={() => {
                setShowWipeConfirm(false);
                setWipeText("");
              }}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleWipe}
              disabled={wipeText !== "WIPE" || wiping}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {wiping ? "Wiping..." : "Confirm Wipe"}
            </button>
          </>
        }
      >
        <p className="text-gray-600 mb-3">
          This will permanently delete ALL data. Type{" "}
          <strong>WIPE</strong> to confirm.
        </p>
        <input
          type="text"
          value={wipeText}
          onChange={(e) => setWipeText(e.target.value)}
          placeholder="Type WIPE to confirm"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </Modal>
    </div>
  );
}
