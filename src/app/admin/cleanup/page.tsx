"use client";

import { useMemo, useState } from "react";
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
import { trainingTypeLabel } from "@/lib/utils";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";

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
        // Lockstep with SPECIAL_CHARS_REGEX in api/admin/cleanup/route.ts.
        const isSpecial = issues.includes("special_characters") && /[^\p{L}\p{M}\s\-'\d]/u.test(ch);
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
  const { formatDate } = useDateFormat();
  // Student data scan
  const [studentOpen, setStudentOpen] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [results, setResults] = useState<StudentIssue[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<{ count: number } | null>(null);
  const [studentError, setStudentError] = useState<string | null>(null);

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
  // Wipe scope: "data" keeps user accounts, "all" is a factory reset.
  const [wipeScope, setWipeScope] = useState<"data" | "all" | null>(null);
  const [wipeText, setWipeText] = useState("");
  const [wiping, setWiping] = useState(false);

  /**
   * A row is fixable when it has a suggestion that would actually change something.
   * Character-identical to POST's skip rule, so "Fix Selected (N)" always matches
   * the server's fixedCount.
   */
  const canFix = (r: StudentIssue) =>
    r.suggestedName.trim().length > 0 && r.suggestedName.trim() !== r.fullName;

  const fixableEmails = useMemo(
    () => new Set(results.filter(canFix).map((r) => r.email)),
    [results]
  );
  // Derive rather than mutate: editing a suggestion to blank after ticking its box
  // would otherwise leave it in `selected` and in the POST payload, so the button
  // would promise more rows than the server reports fixing.
  const effectiveSelected = useMemo(
    () => new Set([...selected].filter((e) => fixableEmails.has(e))),
    [selected, fixableEmails]
  );

  const handleScan = async () => {
    setScanning(true);
    setFixResult(null);
    setStudentError(null);
    try {
      const res = await fetch("/api/admin/cleanup");
      if (res.ok) {
        const data: StudentIssue[] = await res.json();
        setResults(data);
        setSelected(new Set());
        setScanned(true);
      } else {
        setStudentError(
          res.status === 401 ? "Your session has expired — sign in again." : "Scan failed. Please try again."
        );
      }
    } catch {
      setStudentError("Scan failed. Please try again.");
    } finally {
      setScanning(false);
    }
  };

  const handleFix = async () => {
    if (effectiveSelected.size === 0) return;
    setFixing(true);
    setStudentError(null);
    try {
      const updates = results
        .filter((r) => effectiveSelected.has(r.email))
        .map((r) => ({ email: r.email, fullName: r.suggestedName.trim() }));
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
      } else {
        setStudentError(
          res.status === 401 ? "Your session has expired — sign in again." : "Could not apply the fixes. Please try again."
        );
      }
    } catch {
      setStudentError("Could not apply the fixes. Please try again.");
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
    // Denominator is the fixable count, not results.length — otherwise the label
    // can never flip to "Deselect All" once unfixable rows exist.
    if (effectiveSelected.size === fixableEmails.size) {
      setSelected(new Set());
    } else {
      setSelected(new Set(fixableEmails));
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

  // Each scope requires its own confirmation word to avoid an accidental reset.
  const wipeConfirmWord = wipeScope === "all" ? "RESET" : "WIPE";

  const handleWipe = async () => {
    if (!wipeScope || wipeText !== wipeConfirmWord) return;
    setWiping(true);
    try {
      await fetch("/api/admin/wipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: wipeScope }),
      });
      if (wipeScope === "all") {
        // Users are gone — send the operator to the first-run setup wizard.
        window.location.href = "/setup";
        return;
      }
      setWipeScope(null);
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
                      {effectiveSelected.size === fixableEmails.size ? "Deselect All" : "Select All"}
                    </button>
                    <button
                      onClick={handleFix}
                      disabled={fixing || effectiveSelected.size === 0}
                      className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                    >
                      {fixing ? "Fixing..." : `Fix Selected (${effectiveSelected.size})`}
                    </button>
                  </>
                )}
              </div>

              {scanned && results.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <span className="text-sm text-gray-500">Select by issue:</span>
                  {Object.entries(ISSUE_LABELS).map(([key, meta]) => {
                    // Fixable rows only: a chip whose group has no applicable fix
                    // could never reach its "all selected" state.
                    const emailsWithIssue = results
                      .filter((r) => r.issues.includes(key) && fixableEmails.has(r.email))
                      .map((r) => r.email);
                    if (emailsWithIssue.length === 0) return null;
                    const allSelected = emailsWithIssue.every((e) => effectiveSelected.has(e));
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

              {studentError && (
                <div className="flex items-center gap-2 mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                  <AlertTriangle size={16} />
                  {studentError}
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
                              placeholder="No automatic fix — enter a name"
                              className={`w-full px-2 py-1 text-sm font-medium rounded focus:bg-white focus:outline-none focus:ring-2 ${
                                fixableEmails.has(row.email)
                                  ? "text-green-700 bg-green-50 border border-green-200 focus:ring-green-500 focus:border-green-500"
                                  : "text-gray-700 bg-gray-50 border border-gray-300 focus:ring-blue-500 focus:border-blue-500"
                              }`}
                              aria-label={`Suggested name for ${row.email}`}
                            />
                            {!fixableEmails.has(row.email) && row.suggestedName.trim().length > 0 && (
                              <p className="mt-1 text-xs text-gray-500">Same as the current name</p>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <input
                              type="checkbox"
                              checked={effectiveSelected.has(row.email)}
                              disabled={!fixableEmails.has(row.email)}
                              onChange={() => toggleOne(row.email)}
                              title={fixableEmails.has(row.email) ? undefined : "Enter a name to fix this row"}
                              className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 disabled:opacity-40"
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
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 space-y-6">
          {/* Wipe data, keep accounts */}
          <div className="flex items-start gap-3">
            <AlertTriangle size={24} className="text-red-500 shrink-0" />
            <div>
              <h3 className="font-semibold text-red-800">
                Wipe All Data (Keep Accounts)
              </h3>
              <p className="text-sm text-red-600 mt-1">
                Permanently deletes all students, training records, training
                data, product types, region data, programs, companies and
                scheduled exports. Your <strong>user accounts are kept</strong>{" "}
                so you stay signed in. This action cannot be undone.
              </p>
              <button
                onClick={() => {
                  setWipeScope("data");
                  setWipeText("");
                }}
                className="mt-3 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Wipe All Data
              </button>
            </div>
          </div>

          {/* Factory reset */}
          <div className="flex items-start gap-3 border-t border-red-200 pt-6">
            <AlertTriangle size={24} className="text-red-500 shrink-0" />
            <div>
              <h3 className="font-semibold text-red-800">
                Factory Reset (Wipe Everything)
              </h3>
              <p className="text-sm text-red-600 mt-1">
                Deletes <strong>everything, including all user accounts</strong>
                , and returns the system to its brand-new state — you&apos;ll be
                taken to the first-run setup wizard to create a new admin. This
                action cannot be undone.
              </p>
              <button
                onClick={() => {
                  setWipeScope("all");
                  setWipeText("");
                }}
                className="mt-3 px-4 py-2 text-sm bg-red-700 text-white rounded-lg hover:bg-red-800"
              >
                Factory Reset
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Wipe Confirmation Modal */}
      <Modal
        open={wipeScope !== null}
        onClose={() => {
          setWipeScope(null);
          setWipeText("");
        }}
        title={wipeScope === "all" ? "Confirm Factory Reset" : "Confirm Data Wipe"}
        actions={
          <>
            <button
              onClick={() => {
                setWipeScope(null);
                setWipeText("");
              }}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleWipe}
              disabled={wipeText !== wipeConfirmWord || wiping}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {wiping
                ? wipeScope === "all"
                  ? "Resetting..."
                  : "Wiping..."
                : wipeScope === "all"
                ? "Confirm Reset"
                : "Confirm Wipe"}
            </button>
          </>
        }
      >
        <p className="text-gray-600 mb-3">
          {wipeScope === "all" ? (
            <>
              This will permanently delete <strong>ALL data and every user
              account</strong> and return the system to the setup screen. Type{" "}
              <strong>RESET</strong> to confirm.
            </>
          ) : (
            <>
              This will permanently delete ALL data (user accounts are kept).
              Type <strong>WIPE</strong> to confirm.
            </>
          )}
        </p>
        <input
          type="text"
          value={wipeText}
          onChange={(e) => setWipeText(e.target.value)}
          placeholder={`Type ${wipeConfirmWord} to confirm`}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </Modal>
    </div>
  );
}
