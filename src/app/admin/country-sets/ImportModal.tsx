"use client";

import { useRef, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { AlertCircle, CheckCircle, Download, FileSpreadsheet, Upload } from "lucide-react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { SELECT_CLASS } from "@/components/ui/FormControls";
import CompanyPicker from "@/components/company/CompanyPicker";
import { checkImportFile } from "@/lib/import-file";

/**
 * Country Sets import dialog: upload a CSV/Excel file, map its columns, preview
 * (a `?dryRun=true` call — nothing is written), then import. The columns are
 * the export's own, so an exported file round-trips. The semantics — per-set
 * overwrite of the countries, company per row with a default for blank cells,
 * all-or-nothing per set — live in `api/admin/country-sets/import/route.ts`.
 */

type FieldKey = "company" | "name" | "description" | "countries";

const TARGET_FIELDS: { key: FieldKey; label: string; required: boolean; aliases: string[] }[] = [
  { key: "company", label: "Company", required: false, aliases: ["company", "companyname", "partner"] },
  { key: "name", label: "Name", required: true, aliases: ["name", "countryset", "set", "setname"] },
  { key: "description", label: "Description", required: false, aliases: ["description", "notes"] },
  { key: "countries", label: "Countries", required: true, aliases: ["countries", "country", "members"] },
];

const TEMPLATE_CSV =
  'Company,Name,Description,Countries\n' +
  'Company A,Set 1,Example set,Country A; Country B\n' +
  'Company A,Set 2,,Country C\n';

interface ImportResult {
  dryRun?: boolean;
  created: number;
  updated: number;
  unchanged?: number;
  /** Sets the import will leave (or left) with no countries — an explicit "none". */
  emptied?: number;
  skippedSets: number;
  errorsTruncated?: boolean;
  /** Companies the import wrote to (real imports only). */
  companyIds?: number[];
  errors: { row: number; message: string }[];
  sets?: { company: string; name: string; countries: number; action: "create" | "update" | "unchanged" }[];
}

type Step = "upload" | "mapping" | "preview" | "importing" | "summary";

function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z]/g, "");
}

export default function ImportCountrySetsModal({
  open,
  onClose,
  onImported,
  companies,
  defaultCompanyId,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Called when the dialog closes after a real import was sent, with the
   * companies it wrote to (empty when unknown, e.g. the request failed in
   * flight). Deferred to close on purpose: refreshing the list puts the page
   * back in its loading state, which unmounts this dialog and would swallow
   * the summary.
   */
  onImported: (companyIds: number[]) => void;
  companies: { id: number; name: string }[];
  defaultCompanyId: number | "";
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<FieldKey, string>>>({});
  const [companyId, setCompanyId] = useState<number | "">(defaultCompanyId);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  // Set as soon as a real import is SENT, not when it succeeds: the write may
  // land even if the response is lost, so the list must refresh either way.
  const [wrote, setWrote] = useState(false);
  const [wroteCompanies, setWroteCompanies] = useState<number[]>([]);

  const reset = () => {
    setStep("upload");
    setFileName("");
    setHeaders([]);
    setRows([]);
    setMapping({});
    setError(null);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const close = () => {
    // Closing mid-import would unmount the dialog before it learns the result.
    if (step === "importing") return;
    reset();
    onClose();
    if (wrote) onImported(wroteCompanies);
  };

  const loaded = (hdrs: string[], data: Record<string, string>[]) => {
    const next: Partial<Record<FieldKey, string>> = {};
    for (const f of TARGET_FIELDS) {
      const match = hdrs.find((h) => f.aliases.includes(normaliseHeader(h)));
      if (match) next[f.key] = match;
    }
    setHeaders(hdrs);
    setRows(data);
    setMapping(next);
    setStep("mapping");
  };

  const parseFile = (file: File) => {
    setError(null);
    setFileName(file.name);
    // Bound the input before it is buffered and parsed in this tab.
    const rejection = checkImportFile(file);
    if (rejection) {
      setError(rejection);
      return;
    }
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext === "csv") {
      // Normalise line endings first: Papa takes the newline style from the
      // first line, so an export (CRLF) with rows appended in an editor that
      // writes LF would otherwise fail as "Quoted field unterminated".
      file
        .text()
        .then((text) => {
          const res = Papa.parse<Record<string, string>>(text.replace(/\r\n?/g, "\n"), {
            header: true,
            skipEmptyLines: true,
          });
          if (res.errors.length > 0) {
            setError(`Parse errors: ${res.errors.map((e) => e.message).join(", ")}`);
            return;
          }
          loaded(res.meta.fields || [], res.data);
        })
        .catch(() => setError("Failed to read the CSV file"));
    } else if (ext === "xls" || ext === "xlsx") {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const workbook = XLSX.read(new Uint8Array(e.target?.result as ArrayBuffer), { type: "array" });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const all = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false });
          if (all.length < 2) {
            setError("No data found in file");
            return;
          }
          const hdrs = (all[0] || []).map((h) => String(h).trim()).filter(Boolean);
          loaded(hdrs, XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { raw: false, defval: "" }));
        } catch (err) {
          setError(`Failed to parse Excel: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setError("Unsupported file type. Please upload a CSV or Excel file.");
    }
  };

  const mappedRows = () =>
    rows.map((r) => ({
      company: mapping.company ? r[mapping.company] ?? "" : "",
      name: mapping.name ? r[mapping.name] ?? "" : "",
      description: mapping.description ? r[mapping.description] ?? "" : "",
      countries: mapping.countries ? r[mapping.countries] ?? "" : "",
    }));

  const submit = async (dryRun: boolean) => {
    const missing = TARGET_FIELDS.filter((f) => f.required && !mapping[f.key]);
    if (missing.length > 0) {
      setError(`Please map: ${missing.map((f) => f.label).join(", ")}`);
      return;
    }
    if (!mapping.company && companyId === "") {
      setError("Choose a company, or map a Company column");
      return;
    }
    setError(null);
    setStep(dryRun ? "mapping" : "importing");
    if (!dryRun) setWrote(true);
    try {
      const res = await fetch(`/api/admin/country-sets/import${dryRun ? "?dryRun=true" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: mappedRows(),
          defaultCompanyId: companyId === "" ? null : companyId,
          descriptionMapped: !!mapping.description,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Import failed");
        setStep(dryRun ? "mapping" : "preview");
        return;
      }
      setResult(data as ImportResult);
      if (dryRun) {
        setStep("preview");
      } else {
        setStep("summary");
        setWroteCompanies((prev) => [...new Set([...prev, ...((data as ImportResult).companyIds ?? [])])]);
      }
    } catch {
      setError("Import failed");
      setStep(dryRun ? "mapping" : "preview");
    }
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE_CSV], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "country-sets-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const errorList = (errs: ImportResult["errors"]) =>
    errs.length > 0 && (
      <div>
        <h4 className="text-sm font-semibold text-red-700 mb-2">Errors ({errs.length})</h4>
        <div className="max-h-48 overflow-y-auto bg-red-50 rounded-lg p-3">
          {errs.map((e, i) => (
            <div key={i} className="text-sm text-red-600 py-0.5">
              Row {e.row}: {e.message}
            </div>
          ))}
        </div>
      </div>
    );

  return (
    <Modal open={open} onClose={close} title="Import Country Sets" size="2xl">
      <div className="space-y-4">
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={downloadTemplate}>
            <Download size={14} /> Download Template
          </Button>
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
            <AlertCircle size={18} className="text-red-500 mt-0.5 shrink-0" />
            <span className="text-red-700 text-sm">{error}</span>
          </div>
        )}

        {step === "upload" && (
          <>
            <p className="text-sm text-gray-600">
              Use the same columns as the export: Company, Name, Description and Countries (separate countries with
              semicolons or commas, or put one country per row). Each set named in the file ends up with exactly the
              countries the file lists for it; sets the file does not mention are left alone. To empty a set on
              purpose, put &ldquo;none&rdquo; in its Countries cell.
            </p>
            <div
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) parseFile(file);
              }}
              onDragOver={(e) => e.preventDefault()}
              className="border-2 border-dashed border-gray-300 rounded-lg p-10 text-center hover:border-blue-400 transition-colors cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={40} className="mx-auto text-gray-400 mb-3" />
              <p className="text-base font-medium text-gray-700 mb-1">Drop your CSV or Excel file here</p>
              <p className="text-sm text-gray-500 mb-3">or click to browse files</p>
              <p className="text-xs text-gray-400">Supported formats: .csv, .xls, .xlsx</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xls,.xlsx"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) parseFile(file);
                }}
                className="hidden"
              />
            </div>
          </>
        )}

        {(step === "mapping" || step === "preview") && (
          <>
            <div className="flex items-center gap-2">
              <FileSpreadsheet size={18} className="text-blue-500" />
              <span className="font-medium text-sm">{fileName}</span>
              <span className="text-xs text-gray-500">
                ({rows.length} rows, {headers.length} columns)
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {TARGET_FIELDS.map((f) => (
                <div key={f.key} className="flex items-center gap-3 min-w-0">
                  <label className="w-24 shrink-0 text-sm font-medium text-gray-700">
                    {f.label}
                    {f.required && <span className="text-red-500 ml-1">*</span>}
                  </label>
                  <select
                    value={mapping[f.key] ?? ""}
                    onChange={(e) => {
                      setMapping((m) => ({ ...m, [f.key]: e.target.value || undefined }));
                      setStep("mapping");
                      setResult(null);
                    }}
                    className={`${SELECT_CLASS} flex-1 min-w-0`}
                  >
                    <option value="">-- Not mapped --</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-3 min-w-0">
              <label className="w-24 shrink-0 text-sm font-medium text-gray-700" htmlFor="import-default-company">
                {mapping.company ? "Default company" : "Company"}
                {!mapping.company && <span className="text-red-500 ml-1">*</span>}
              </label>
              <CompanyPicker
                id="import-default-company"
                options={companies}
                value={companyId === "" ? null : companyId}
                onChange={(next) => {
                  setCompanyId(typeof next === "number" ? next : "");
                  setStep("mapping");
                  setResult(null);
                }}
                clearable
                placeholder="-- Select a company --"
                className="flex-1 min-w-0"
              />
            </div>
            <p className="text-xs text-gray-500">
              {mapping.company
                ? "Rows whose Company cell is blank go to the default company. A company must match one you have access to, by name."
                : "Every set in the file is imported into this company."}
            </p>

            {step === "preview" && result && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-green-50 rounded-lg p-3 text-center">
                    <div className="text-xl font-bold text-green-700">{result.created}</div>
                    <div className="text-xs text-green-600">New sets</div>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-3 text-center">
                    <div className="text-xl font-bold text-blue-700">{result.updated}</div>
                    <div className="text-xs text-blue-600">Sets updated (countries replaced)</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-center">
                    <div className="text-xl font-bold text-gray-700">{result.unchanged ?? 0}</div>
                    <div className="text-xs text-gray-600">Unchanged</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-center">
                    <div className="text-xl font-bold text-gray-700">{result.skippedSets}</div>
                    <div className="text-xs text-gray-600">Sets skipped (errors)</div>
                  </div>
                </div>
                {result.sets && result.sets.length > 0 && (
                  <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-gray-50 text-left">
                          <th className="px-3 py-2">Company</th>
                          <th className="px-3 py-2">Name</th>
                          <th className="px-3 py-2">Countries</th>
                          <th className="px-3 py-2">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.sets.map((s, i) => (
                          <tr key={i} className="border-t border-gray-100">
                            <td className="px-3 py-1.5">{s.company}</td>
                            <td className="px-3 py-1.5">{s.name}</td>
                            <td className="px-3 py-1.5">{s.countries}</td>
                            <td className="px-3 py-1.5">
                              {s.action === "create" ? "Create" : s.action === "update" ? "Replace countries" : "No change"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {(result.emptied ?? 0) > 0 && (
                  <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
                    {result.emptied} set{result.emptied === 1 ? "" : "s"} will be left with no countries.
                  </div>
                )}
                {errorList(result.errors)}
                {result.errorsTruncated && (
                  <p className="text-xs text-gray-500">Only the first errors are listed.</p>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-3 pt-2">
              <Button variant="secondary" onClick={reset}>
                Back
              </Button>
              <Button variant="secondary" onClick={() => submit(true)}>
                Preview
              </Button>
              <Button
                onClick={() => submit(false)}
                disabled={step !== "preview" || !result || result.created + result.updated === 0}
                title={result && result.created + result.updated === 0 ? "Nothing to change" : undefined}
              >
                Import
              </Button>
            </div>
            {step === "mapping" && (
              <p className="text-xs text-gray-500">Preview first — nothing is written until you click Import.</p>
            )}
          </>
        )}

        {step === "importing" && (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mb-4" />
            <p className="text-gray-600">Importing {rows.length} rows…</p>
          </div>
        )}

        {step === "summary" && result && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <CheckCircle size={22} className="text-green-500" />
              <h4 className="text-base font-semibold">Import complete</h4>
            </div>
            <p className="text-sm text-gray-700">
              {result.created} new, {result.updated} updated, {result.unchanged ?? 0} unchanged,{" "}
              {result.skippedSets} skipped.
            </p>
            {errorList(result.errors)}
            <div className="flex gap-3 pt-2">
              <Button variant="secondary" onClick={close}>
                Done
              </Button>
              <Button onClick={reset}>Import another file</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
