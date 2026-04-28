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
} from "lucide-react";

interface StudentIssue {
  email: string;
  fullName: string;
  issues: string[];
  suggestedName: string;
}

const ISSUE_LABELS: Record<string, { label: string; color: string }> = {
  leading_trailing_spaces: { label: "Spaces", color: "bg-yellow-100 text-yellow-800" },
  email_as_name: { label: "Email as Name", color: "bg-purple-100 text-purple-800" },
  question_marks: { label: "Question Marks", color: "bg-violet-100 text-violet-800" },
  numbers: { label: "Numbers", color: "bg-orange-100 text-orange-800" },
  special_characters: { label: "Special Characters", color: "bg-red-100 text-red-800" },
};

function HighlightedName({ fullName, issues }: { fullName: string; issues: string[] }) {
  if (issues.includes("email_as_name")) {
    return <span className="bg-purple-100 text-purple-800 px-1 rounded">{fullName}</span>;
  }

  // Build highlighted characters
  const chars = fullName.split("");
  return (
    <span>
      {chars.map((ch, i) => {
        const isLeadingSpace = issues.includes("leading_trailing_spaces") && i < fullName.length - fullName.trimStart().length;
        const isTrailingSpace = issues.includes("leading_trailing_spaces") && i >= fullName.trimEnd().length;
        const isNumber = issues.includes("numbers") && /[0-9]/.test(ch);
        const isSpecial = issues.includes("special_characters") && /[^\p{L}\s\-'\d]/u.test(ch);

        if (isLeadingSpace || isTrailingSpace) {
          return <span key={i} className="bg-yellow-200 text-yellow-900 px-0.5 rounded" title="Leading/trailing space">&middot;</span>;
        }
        if (isNumber) {
          return <span key={i} className="bg-orange-200 text-orange-900 px-0.5 rounded font-bold">{ch}</span>;
        }
        if (isSpecial) {
          return <span key={i} className="bg-red-200 text-red-900 px-0.5 rounded font-bold">{ch}</span>;
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
        setSelected(new Set(data.map((r) => r.email)));
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
      const res = await fetch("/api/admin/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: Array.from(selected) }),
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
                          <td className="px-4 py-3 text-green-700 font-medium">{row.suggestedName}</td>
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
