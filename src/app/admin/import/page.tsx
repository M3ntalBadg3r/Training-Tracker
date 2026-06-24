"use client";

import { useEffect, useState, useRef } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { Upload, FileSpreadsheet, CheckCircle, AlertCircle } from "lucide-react";
import { ImportSummary } from "@/types";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { useAuth } from "@/components/auth/AuthProvider";
import { excelSerialToIso, swapMonthDayIso } from "@/lib/date-format";
import {
  IMPORT_TARGET_FIELDS,
  type ImportTargetFieldKey,
} from "@/lib/import-target-fields";

interface DateFormatMismatch {
  assumedFormat: string;
  detectedFormat: string;
  sampleConflicts: { row: number; value: string }[];
}

interface ExcelDateSwap {
  fixableCount: number;
  samples: { stored: string; corrected: string }[];
}

// Header aliases live in the database (table `import_aliases`, managed at
// /admin/system-settings → Import Aliases tab) so admins can add new variants
// without a code release. We fetch them on mount and pass them to
// autoMapColumns. The key/label list itself is shared with the API for
// validation in src/lib/import-target-fields.ts.
const TARGET_FIELDS = IMPORT_TARGET_FIELDS;

type NameMode = "full" | "firstLast" | "both";

interface CompanyOption { id: number; name: string }

type Step = "upload" | "mapping" | "importing" | "summary";

export default function ImportPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "SuperAdmin";

  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [defaultCompanyId, setDefaultCompanyId] = useState<number | "">("");

  const [formatMismatch, setFormatMismatch] = useState<DateFormatMismatch | null>(null);
  const [dateFormatOverride, setDateFormatOverride] = useState<string | null>(null);
  // Excel workbooks store dates as numeric serials; this flag selects the epoch.
  const [date1904, setDate1904] = useState(false);
  // A DD/MM-locale Excel round-trip can silently transpose native date cells'
  // day and month. When detected we prompt the user to un-swap them on import.
  const [unswapExcelDates, setUnswapExcelDates] = useState(false);
  const [swapPrompt, setSwapPrompt] = useState<ExcelDateSwap | null>(null);
  const [swapAcknowledged, setSwapAcknowledged] = useState(false);
  // Which name columns the file appears to have; drives field/column visibility.
  const [nameMode, setNameMode] = useState<NameMode>("both");
  // Header aliases, fetched at mount from /api/import-aliases and grouped by
  // target field. Empty until the fetch resolves (autoMapColumns is a no-op
  // until then; the user can still map columns manually).
  const [aliasesByField, setAliasesByField] = useState<
    Partial<Record<ImportTargetFieldKey, string[]>>
  >({});

  const visibleFields = TARGET_FIELDS.filter((f) => {
    if (f.key === "firstName" || f.key === "lastName") return nameMode !== "full";
    if (f.key === "fullName") return nameMode !== "firstLast";
    return true;
  });

  useEffect(() => {
    fetch("/api/companies")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { companies: CompanyOption[] }) => {
        setCompanies(data.companies);
        if (data.companies.length === 1) setDefaultCompanyId(data.companies[0].id);
      })
      .catch(() => setCompanies([]));
  }, []);

  useEffect(() => {
    fetch("/api/import-aliases")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { targetField: string; alias: string }[]) => {
        const grouped: Partial<Record<ImportTargetFieldKey, string[]>> = {};
        for (const row of data) {
          const key = row.targetField as ImportTargetFieldKey;
          (grouped[key] ||= []).push(row.alias);
        }
        setAliasesByField(grouped);
      })
      .catch(() => setAliasesByField({}));
  }, []);

  const parseFile = (file: File) => {
    setError(null);
    setFileName(file.name);
    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "csv") {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (result) => {
          if (result.errors.length > 0) {
            setError(`Parse errors: ${result.errors.map((e) => e.message).join(", ")}`);
            return;
          }
          const hdrs = result.meta.fields || [];
          setHeaders(hdrs);
          setRows(result.data as Record<string, string>[]);
          autoMapColumns(hdrs);
          setStep("mapping");
        },
        error: (err) => setError(`Failed to parse CSV: ${err.message}`),
      });
    } else if (ext === "xls" || ext === "xlsx") {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: "array" });
          setDate1904(!!workbook.Workbook?.WBProps?.date1904);
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          // Read header row separately to capture ALL columns, even those empty in the first data rows
          const allRows = XLSX.utils.sheet_to_json<string[]>(sheet, {
            header: 1,
            raw: false,
          });
          if (allRows.length < 2) {
            setError("No data found in file");
            return;
          }
          const hdrs = (allRows[0] || []).map((h) => String(h).trim()).filter(Boolean);
          // raw:true so native Excel date cells surface as their numeric serial
          // (e.g. 44385) instead of a flattened display string like "7/8/21".
          // We stringify every value here and decode date serials later, once
          // the user has mapped the completed-date column (resolveDateCell).
          const rawData = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
            raw: true,
            defval: "",
          });
          const jsonData: Record<string, string>[] = rawData.map((r) => {
            const out: Record<string, string> = {};
            for (const key of Object.keys(r)) {
              const v = r[key];
              out[key] = v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? "" : String(v);
            }
            return out;
          });
          setHeaders(hdrs);
          setRows(jsonData);
          autoMapColumns(hdrs);
          setStep("mapping");
        } catch (err) {
          setError(`Failed to parse Excel: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setError("Unsupported file type. Please upload a CSV or Excel file.");
    }
  };

  const autoMapColumns = (hdrs: string[]) => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    const mapping: Record<string, string> = {};
    for (const field of TARGET_FIELDS) {
      const aliases = aliasesByField[field.key] || [];
      if (aliases.length === 0) continue;
      const wanted = aliases.map(norm);
      const match = hdrs.find((h) => wanted.includes(norm(h)));
      if (match) mapping[field.key] = match;
    }
    setColumnMapping(mapping);

    const hasFull = !!mapping.fullName;
    const hasFirstLast = !!mapping.firstName && !!mapping.lastName;
    if (hasFull && !hasFirstLast) setNameMode("full");
    else if (hasFirstLast && !hasFull) setNameMode("firstLast");
    else setNameMode("both");
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
  };

  const todayIso = () => new Date().toISOString().slice(0, 10);

  // A bare integer in a date cell is an Excel date serial (native date cell read
  // via raw:true) — decode it to ISO. Text dates pass through untouched for the
  // server's format-aware parser. When `unswap` is set, native serials have had
  // their day/month transposed by an upstream Excel locale round-trip; we swap a
  // serial back only when the swapped date is valid and not in the future. A
  // completion date can never be in the future, so if swapping would produce a
  // future date the decoded value is the genuine one (e.g. a recent entry like
  // 2026-05-06 whose swap 2026-06-05 hasn't happened yet). day > 12 serials
  // can't be swapped and are left as decoded.
  const resolveDateCell = (raw: string, unswap: boolean): string => {
    const v = (raw ?? "").trim();
    if (/^\d+$/.test(v)) {
      const iso = excelSerialToIso(Number(v), date1904);
      if (!iso) return raw;
      if (unswap) {
        const swapped = swapMonthDayIso(iso);
        if (swapped && swapped <= todayIso()) return swapped;
      }
      return iso;
    }
    return raw;
  };

  // Detect the day/month-swap corruption by its symptom: a native Excel date
  // serial that decodes to a FUTURE date but whose swap is a valid non-future
  // date. Completion dates can't be in the future, so a future-decoding native
  // cell that swapping fixes is unambiguous evidence the day and month were
  // transposed. Clean files (no future completion dates) never trigger this.
  const detectExcelDateSwap = (): ExcelDateSwap | null => {
    const dateCol = columnMapping.completedDate;
    if (!dateCol) return null;
    const today = todayIso();
    let fixableCount = 0;
    const samples: { stored: string; corrected: string }[] = [];
    for (const r of rows) {
      const v = (r[dateCol] ?? "").trim();
      if (!/^\d+$/.test(v)) continue;
      const iso = excelSerialToIso(Number(v), date1904);
      if (!iso || iso <= today) continue; // only future-decoding native cells
      const swapped = swapMonthDayIso(iso);
      if (!swapped || swapped > today) continue; // swap must actually fix it
      fixableCount++;
      if (samples.length < 3) samples.push({ stored: iso, corrected: swapped });
    }
    return fixableCount >= 1 ? { fixableCount, samples } : null;
  };

  const runImport = async (override: string | null, unswap: boolean) => {
    setStep("importing");
    setError(null);
    try {
      // Decode Excel date serials in the mapped completed-date column before
      // sending; the server then sees ISO for native dates + text for the rest.
      const dateCol = columnMapping.completedDate;
      const outRows = dateCol
        ? rows.map((r) => ({ ...r, [dateCol]: resolveDateCell(r[dateCol], unswap) }))
        : rows;
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: outRows,
          columnMapping,
          defaultCompanyId: defaultCompanyId || undefined,
          ...(override ? { dateFormatOverride: override } : {}),
        }),
      });

      if (res.status === 409) {
        const data = await res.json();
        if (data?.error === "dateFormatMismatch") {
          setFormatMismatch({
            assumedFormat: data.assumedFormat,
            detectedFormat: data.detectedFormat,
            sampleConflicts: Array.isArray(data.sampleConflicts) ? data.sampleConflicts : [],
          });
          setStep("mapping");
          return;
        }
        if (data?.error === "dateFormatInconsistent") {
          setError(data.message || "Date column has mixed formats — clean the file and retry.");
          setStep("mapping");
          return;
        }
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        setError(errorData.error || "Import failed");
        setStep("mapping");
        return;
      }

      const result = await res.json();
      setSummary(result);
      setStep("summary");
    } catch (err) {
      setError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      setStep("mapping");
    }
  };

  const handleImport = async () => {
    // Validate all required fields are mapped
    const missingFields = TARGET_FIELDS.filter(
      (f) => f.required && !columnMapping[f.key]
    );
    if (missingFields.length > 0) {
      setError(
        `Please map the following fields: ${missingFields.map((f) => f.label).join(", ")}`
      );
      return;
    }

    // Name is an either-or: a Full Name column, OR both First Name and Last Name.
    const hasName =
      !!columnMapping.fullName ||
      (!!columnMapping.firstName && !!columnMapping.lastName);
    if (!hasName) {
      setError("Map a Full Name column, or both First Name and Last Name.");
      return;
    }

    // If the file has no Company column, a default company is required.
    if (!columnMapping.company && !defaultCompanyId) {
      setError(
        "Please pick a default company for rows that don't include one (or map a Company column)."
      );
      return;
    }

    setDateFormatOverride(null);

    // Before importing, check for the day/month-swap signature in native Excel
    // date cells and prompt once. Text dates are handled by the format pipeline.
    if (!swapAcknowledged) {
      const ev = detectExcelDateSwap();
      if (ev) {
        setSwapPrompt(ev);
        return;
      }
    }

    await runImport(null, unswapExcelDates);
  };

  const handleAcceptDetectedFormat = async () => {
    if (!formatMismatch) return;
    const next = formatMismatch.detectedFormat;
    setDateFormatOverride(next);
    setFormatMismatch(null);
    await runImport(next, unswapExcelDates);
  };

  const handleSwapChoice = async (unswap: boolean) => {
    setUnswapExcelDates(unswap);
    setSwapAcknowledged(true);
    setSwapPrompt(null);
    await runImport(null, unswap);
  };

  const reset = () => {
    setStep("upload");
    setFileName("");
    setHeaders([]);
    setRows([]);
    setColumnMapping({});
    setSummary(null);
    setError(null);
    setFormatMismatch(null);
    setDateFormatOverride(null);
    setDate1904(false);
    setUnswapExcelDates(false);
    setSwapPrompt(null);
    setSwapAcknowledged(false);
    setNameMode("both");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div>
      <PageHeader title="Import" helpSlug="import" />

      <p className="text-sm text-gray-500 mb-6">
        Upload a CSV or Excel file to bulk-import student training records. The wizard will guide you through
        mapping columns from your file to the required fields, then import the data into the system.
      </p>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
          <AlertCircle size={18} className="text-red-500 mt-0.5 shrink-0" />
          <span className="text-red-700 text-sm">{error}</span>
        </div>
      )}

      {/* Step 1: Upload */}
      {step === "upload" && (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          className="border-2 border-dashed border-gray-300 rounded-lg p-12 text-center hover:border-blue-400 transition-colors cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={48} className="mx-auto text-gray-400 mb-4" />
          <p className="text-lg font-medium text-gray-700 mb-2">
            Drop your CSV or Excel file here
          </p>
          <p className="text-sm text-gray-500 mb-4">
            or click to browse files
          </p>
          <p className="text-xs text-gray-400">
            Supported formats: .csv, .xls, .xlsx
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xls,.xlsx"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
      )}

      {/* Step 2: Column Mapping */}
      {step === "mapping" && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4">
              <FileSpreadsheet size={20} className="text-blue-500" />
              <span className="font-medium">{fileName}</span>
              <span className="text-sm text-gray-500">
                ({rows.length} rows, {headers.length} columns)
              </span>
            </div>

            <h3 className="text-lg font-semibold mb-4">Map Columns</h3>
            <p className="text-sm text-gray-600 mb-4">
              Map the columns from your file to the required fields. For the name,
              map either a <strong>Full Name</strong> column, or both{" "}
              <strong>First Name</strong> and <strong>Last Name</strong> (they&apos;ll
              be merged). The Company column is optional — if a row has no value, the
              default company below will be used.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {visibleFields.map((field) => (
                <div key={field.key} className="flex items-center gap-3">
                  <label className="w-40 text-sm font-medium text-gray-700">
                    {field.label}
                    {field.required && (
                      <span className="text-red-500 ml-1">*</span>
                    )}
                  </label>
                  <select
                    value={columnMapping[field.key] || ""}
                    onChange={(e) =>
                      setColumnMapping((prev) => ({
                        ...prev,
                        [field.key]: e.target.value,
                      }))
                    }
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">-- Select column --</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="mt-6 border-t border-gray-200 pt-4">
              <h4 className="text-sm font-semibold mb-2">Default Company</h4>
              <p className="text-xs text-gray-500 mb-2">
                Used for rows where the Company column is empty or unmapped.
                {isSuperAdmin
                  ? " As a SuperAdmin, any unknown company name in the file will be auto-created."
                  : " Rows referencing companies you do not have access to will be rejected."}
              </p>
              <select
                value={defaultCompanyId === "" ? "" : String(defaultCompanyId)}
                onChange={(e) =>
                  setDefaultCompanyId(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="w-full md:w-1/2 border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">-- Select a default company --</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Preview */}
            {rows.length > 0 && (
              <div className="mt-6">
                <h4 className="text-sm font-semibold mb-2">
                  Preview (first 5 rows)
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border border-gray-200">
                    <thead>
                      <tr className="bg-gray-50">
                        {visibleFields.map((f) => (
                          <th key={f.key} className="px-3 py-2 text-left border-b">
                            {f.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 5).map((row, idx) => (
                        <tr key={idx} className="border-b">
                          {visibleFields.map((f) => {
                            const cell = columnMapping[f.key] ? row[columnMapping[f.key]] : "";
                            const display = f.key === "completedDate" ? resolveDateCell(cell, unswapExcelDates) : cell;
                            return (
                              <td key={f.key} className="px-3 py-2 text-gray-600">
                                {display || "-"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={reset}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Back
            </button>
            <button
              onClick={handleImport}
              className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Import Data
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Importing */}
      {step === "importing" && (
        <div className="flex flex-col items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4" />
          <p className="text-gray-600">Importing {rows.length} rows...</p>
        </div>
      )}

      {/* Step 4: Summary */}
      {step === "summary" && summary && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle size={24} className="text-green-500" />
              <h3 className="text-lg font-semibold">Import Complete</h3>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-green-50 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-green-700">
                  {summary.studentsCreated}
                </div>
                <div className="text-sm text-green-600">Students Created</div>
              </div>
              <div className="bg-blue-50 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-blue-700">
                  {summary.studentsUpdated}
                </div>
                <div className="text-sm text-blue-600">Students Existing</div>
              </div>
              <div className="bg-green-50 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-green-700">
                  {summary.trainingsCreated}
                </div>
                <div className="text-sm text-green-600">Trainings Imported</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-gray-700">
                  {summary.trainingsSkipped}
                </div>
                <div className="text-sm text-gray-600">Trainings Skipped</div>
              </div>
            </div>

            {summary.dateFormatUsed && (
              <p className="mb-3 text-xs text-gray-500">
                Dates parsed as <span className="font-mono">{summary.dateFormatUsed}</span>
                {dateFormatOverride ? " (override for this import)" : ""}.
              </p>
            )}

            {(summary.companiesCreated ?? 0) > 0 && (
              <div className="mb-3 flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-lg p-4">
                <CheckCircle size={18} className="text-blue-600 mt-0.5 shrink-0" />
                <p className="text-sm text-blue-800">
                  {summary.companiesCreated} new {summary.companiesCreated === 1 ? "company was" : "companies were"} auto-created during this import.
                </p>
              </div>
            )}

            {(summary.trainingsAutoCreated ?? 0) > 0 && (
              <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4">
                <div className="shrink-0 mt-0.5">
                  <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-amber-800">
                    {summary.trainingsAutoCreated} new placeholder training {summary.trainingsAutoCreated === 1 ? "entry" : "entries"} created
                  </p>
                  <p className="text-sm text-amber-700">
                    Visit{" "}
                    <a href="/admin/training-data" className="underline font-medium hover:text-amber-900">
                      Training Data
                    </a>{" "}
                    to fill in the details and mark each one complete.
                  </p>
                </div>
              </div>
            )}

            {summary.errors.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-amber-700 mb-2">
                  Issues ({summary.errors.length})
                </h4>
                <p className="text-xs text-gray-500 mb-2">
                  Includes hard errors (rows skipped) and warnings (rows imported with adjustments).
                </p>
                <div className="max-h-60 overflow-y-auto bg-amber-50 rounded-lg p-3">
                  {summary.errors.map((err, idx) => (
                    <div key={idx} className="text-sm text-amber-700 py-1">
                      {err}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={reset}
            className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Import Another File
          </button>
        </div>
      )}

      <Modal
        open={!!formatMismatch}
        onClose={() => setFormatMismatch(null)}
        title="Date format mismatch"
        actions={
          <>
            <button
              onClick={() => setFormatMismatch(null)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleAcceptDetectedFormat}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Use {formatMismatch?.detectedFormat} for this import
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-gray-700">
            The system is configured for{" "}
            <span className="font-semibold">{formatMismatch?.assumedFormat}</span>{" "}
            but this file looks like{" "}
            <span className="font-semibold">{formatMismatch?.detectedFormat}</span>.
          </p>
          {formatMismatch && formatMismatch.sampleConflicts.length > 0 && (
            <div>
              <p className="text-gray-500 mb-1">Cells that don&apos;t fit {formatMismatch.assumedFormat}:</p>
              <ul className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-2 max-h-32 overflow-y-auto">
                {formatMismatch.sampleConflicts.map((c) => (
                  <li key={`${c.row}-${c.value}`} className="text-gray-700">
                    Row {c.row}: <span className="font-mono">{c.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-gray-500">
            Cancel and update the system default in Admin &rarr; System Settings if you&apos;d
            rather change it permanently. Continuing uses the detected format for this
            import only — the system default stays unchanged.
          </p>
        </div>
      </Modal>

      <Modal
        open={!!swapPrompt}
        onClose={() => setSwapPrompt(null)}
        title="Day/month-swapped Excel dates detected"
        actions={
          <>
            <button
              onClick={() => setSwapPrompt(null)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={() => handleSwapChoice(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Import as-is
            </button>
            <button
              onClick={() => handleSwapChoice(true)}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Yes, correct them
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-gray-700">
            <span className="font-semibold">{swapPrompt?.fixableCount}</span> native
            Excel date {swapPrompt?.fixableCount === 1 ? "cell decodes" : "cells decode"} to
            a date in the future, which means their{" "}
            <span className="font-semibold">day and month have been transposed</span> —
            a known side effect of opening and saving the file in an Excel set to a
            different regional date format. Other transposed dates in the column are
            corrected too; genuine recent dates are left untouched.
          </p>
          {swapPrompt && swapPrompt.samples.length > 0 && (
            <div>
              <p className="text-gray-500 mb-1">Examples of the correction:</p>
              <ul className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-2 max-h-32 overflow-y-auto">
                {swapPrompt.samples.map((s) => (
                  <li key={s.stored} className="text-gray-700">
                    <span className="font-mono">{s.stored}</span> &rarr;{" "}
                    <span className="font-mono">{s.corrected}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-gray-500">
            Text date cells are not affected and continue through the usual format
            detection. Choose <span className="font-semibold">Yes, correct them</span>{" "}
            to swap the day and month back, or <span className="font-semibold">Import
            as-is</span> if these dates are genuinely correct.
          </p>
        </div>
      </Modal>
    </div>
  );
}
