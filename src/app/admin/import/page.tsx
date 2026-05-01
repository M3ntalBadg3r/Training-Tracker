"use client";

import { useEffect, useState, useRef } from "react";
import PageHeader from "@/components/layout/PageHeader";
import { Upload, FileSpreadsheet, CheckCircle, AlertCircle } from "lucide-react";
import { ImportSummary } from "@/types";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { useAuth } from "@/components/auth/AuthProvider";

const TARGET_FIELDS = [
  { key: "fullName", label: "Full Name", required: true },
  { key: "email", label: "Email Address", required: true },
  { key: "theatre", label: "Theatre", required: true },
  { key: "country", label: "Country", required: true },
  { key: "title", label: "Title", required: true },
  { key: "completedDate", label: "Completed Date", required: true },
  { key: "company", label: "Company", required: false },
];

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

  useEffect(() => {
    fetch("/api/companies")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { companies: CompanyOption[] }) => {
        setCompanies(data.companies);
        if (data.companies.length === 1) setDefaultCompanyId(data.companies[0].id);
      })
      .catch(() => setCompanies([]));
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
          const jsonData = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
            raw: false,
            defval: "",
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
    const mapping: Record<string, string> = {};
    for (const field of TARGET_FIELDS) {
      const match = hdrs.find(
        (h) =>
          h.toLowerCase().replace(/[^a-z]/g, "") ===
          field.label.toLowerCase().replace(/[^a-z]/g, "")
      );
      if (match) mapping[field.key] = match;
    }
    setColumnMapping(mapping);
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

    // If the file has no Company column, a default company is required.
    if (!columnMapping.company && !defaultCompanyId) {
      setError(
        "Please pick a default company for rows that don't include one (or map a Company column)."
      );
      return;
    }

    setStep("importing");
    setError(null);

    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, columnMapping, defaultCompanyId: defaultCompanyId || undefined }),
      });

      if (!res.ok) {
        const errorData = await res.json();
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

  const reset = () => {
    setStep("upload");
    setFileName("");
    setHeaders([]);
    setRows([]);
    setColumnMapping({});
    setSummary(null);
    setError(null);
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
              Map the columns from your file to the required fields. The Company
              column is optional — if a row has no value, the default company below
              will be used.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {TARGET_FIELDS.map((field) => (
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
                        {TARGET_FIELDS.map((f) => (
                          <th key={f.key} className="px-3 py-2 text-left border-b">
                            {f.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 5).map((row, idx) => (
                        <tr key={idx} className="border-b">
                          {TARGET_FIELDS.map((f) => (
                            <td key={f.key} className="px-3 py-2 text-gray-600">
                              {columnMapping[f.key]
                                ? row[columnMapping[f.key]] || "-"
                                : "-"}
                            </td>
                          ))}
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
    </div>
  );
}
