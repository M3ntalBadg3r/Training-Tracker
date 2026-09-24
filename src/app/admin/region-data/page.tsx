"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { RegionDataRow } from "@/types";
import {
  Plus,
  Trash2,
  Save,
  Upload,
  Download,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  Search,
  ChevronUp,
  ChevronDown,
  Wand2,
} from "lucide-react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { checkImportFile } from "@/lib/import-file";
// Type-only: erased at build, so the country table itself stays out of this
// page's bundle. The data module is pulled in with a dynamic import when the
// admin actually asks for suggestions.
import type { IsoSuggestion } from "@/lib/iso-countries";

const TARGET_FIELDS = [
  { key: "country", label: "Country", required: true, aliases: ["country"] },
  { key: "region", label: "Region", required: true, aliases: ["region"] },
  { key: "theatre", label: "Theatre", required: false, aliases: ["theatre", "theater"] },
  {
    key: "isoCode",
    label: "ISO Code",
    required: false,
    aliases: ["isocode", "iso", "iso2", "iso31661", "alpha2", "countrycode"],
  },
];

// One definition shared by the CSV, Excel and PDF exports so a new column
// cannot reach two of the three and be missing from the other.
const EXPORT_COLUMNS: { key: keyof RegionDataRow; header: string }[] = [
  { key: "country", header: "Country" },
  { key: "region", header: "Region" },
  { key: "theatre", header: "Theatre" },
  { key: "isoCode", header: "ISO Code" },
];

/** One proposed code, awaiting a human decision. Nothing here is written. */
interface IsoSuggestionRow extends IsoSuggestion {
  country: string;
  region: string;
}

type ImportStep = "upload" | "mapping" | "importing" | "summary";

interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

type SortColumn = "country" | "region" | "theatre" | "isoCode";

export default function RegionDataPage() {
  const [regions, setRegions] = useState<RegionDataRow[]>([]);
  const [editingRegion, setEditingRegion] = useState<string | null>(null);
  const [editCountryValue, setEditCountryValue] = useState("");
  const [editRegionValue, setEditRegionValue] = useState("");
  const [editTheatreValue, setEditTheatreValue] = useState("");
  const [editIsoValue, setEditIsoValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Search and filter state (Training Data style)
  const [searchTerm, setSearchTerm] = useState("");
  const [searchColumn, setSearchColumn] = useState("all");
  const [regionFilter, setRegionFilter] = useState("");
  const [theatreFilter, setTheatreFilter] = useState("");
  const [isoFilter, setIsoFilter] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>("country");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  // Add modal state
  const [addModalOpen, setAddModalOpen] = useState(false);
  // A 400 from the write routes used to be swallowed: the modal simply stayed
  // open with no message. The ISO field makes that reachable in normal use —
  // one letter in the box is a valid keystroke and an invalid code.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [newCountry, setNewCountry] = useState("");
  const [newRegionValue, setNewRegionValue] = useState("");
  const [newTheatreValue, setNewTheatreValue] = useState("");
  const [newIsoValue, setNewIsoValue] = useState("");

  // "Suggest ISO codes" review queue. A suggestion is a proposal: nothing is
  // written until the admin ticks it and applies. Auto-applying a name match
  // would be a new silent-mismatch surface, which is the exact failure this
  // column exists to eliminate.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<IsoSuggestionRow[] | null>(null);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // Import state
  const [showImport, setShowImport] = useState(false);
  const [importStep, setImportStep] = useState<ImportStep>("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Countries with no region defined are not a region — they must not become a
  // blank, unselectable-looking option alongside the real ones.
  const uniqueRegions = useMemo(
    () => [...new Set(regions.map((r) => r.region).filter((r): r is string => !!r))].sort(),
    [regions]
  );

  const uniqueTheatres = useMemo(
    () => [...new Set(regions.map((r) => r.theatre).filter((t): t is string => !!t))].sort(),
    [regions]
  );

  const filteredRegions = useMemo(() => {
    let result = [...regions];

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter((r) => {
        if (searchColumn === "country") return r.country.toLowerCase().includes(term);
        if (searchColumn === "region") return r.region.toLowerCase().includes(term);
        if (searchColumn === "theatre") return (r.theatre ?? "").toLowerCase().includes(term);
        if (searchColumn === "isoCode") return (r.isoCode ?? "").toLowerCase().includes(term);
        return (
          r.country.toLowerCase().includes(term) ||
          r.region.toLowerCase().includes(term) ||
          (r.theatre ?? "").toLowerCase().includes(term) ||
          (r.isoCode ?? "").toLowerCase().includes(term)
        );
      });
    }

    if (regionFilter) {
      result = result.filter((r) => r.region === regionFilter);
    }
    if (theatreFilter) {
      result = result.filter((r) =>
        theatreFilter === "__missing__" ? !r.theatre : r.theatre === theatreFilter
      );
    }
    if (isoFilter) {
      result = result.filter((r) => (isoFilter === "__missing__" ? !r.isoCode : !!r.isoCode));
    }

    const cell = (r: RegionDataRow) =>
      sortColumn === "country"
        ? r.country
        : sortColumn === "region"
          ? r.region
          : sortColumn === "theatre"
            ? r.theatre ?? ""
            : r.isoCode ?? "";

    result.sort((a, b) => {
      const cmp = cell(a).localeCompare(cell(b));
      return sortDirection === "asc" ? cmp : -cmp;
    });

    return result;
  }, [
    regions,
    searchTerm,
    searchColumn,
    regionFilter,
    theatreFilter,
    isoFilter,
    sortColumn,
    sortDirection,
  ]);

  // Rows still waiting for a code. Rendered as a standing notice rather than
  // left for someone to notice: an unmapped country is a real gap in the data,
  // not a cosmetic one.
  const unmappedCount = useMemo(() => regions.filter((r) => !r.isoCode).length, [regions]);

  const handleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(col);
      setSortDirection("asc");
    }
  };

  const fetchLastImport = useCallback(() => {
    fetch("/api/import-metadata?key=region-data")
      .then((res) => res.json())
      .then((data) => { if (data?.timestamp) setLastImport(data.timestamp); })
      .catch(() => {});
  }, []);

  const fetchRegions = useCallback(() => {
    fetch("/api/region-data")
      .then((r) => r.json())
      .then((data) => { setRegions(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchRegions();
    fetchLastImport();
  }, [fetchRegions, fetchLastImport]);

  const handleAddRegion = async () => {
    // Region may be left blank — that is the "not defined yet" state, and it is
    // what the student import now writes for a country it has never seen.
    if (!newCountry) return;
    const res = await fetch("/api/region-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        country: newCountry,
        region: newRegionValue,
        theatre: newTheatreValue,
        isoCode: newIsoValue,
      }),
    });
    if (res.ok) {
      setAddModalOpen(false);
      setSaveError(null);
      setNewCountry("");
      setNewRegionValue("");
      setNewTheatreValue("");
      setNewIsoValue("");
      fetchRegions();
    } else {
      setSaveError(await readError(res));
    }
  };

  // The routes answer a rejection with `{ error }`; anything else (a proxy
  // page, a network failure) must still say something rather than nothing.
  const readError = async (res: Response): Promise<string> => {
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") return body.error;
    } catch {
      // fall through to the generic message
    }
    return "Could not save. Please check the values and try again.";
  };

  const handleUpdateRegion = async (originalCountry: string) => {
    const trimmedTheatre = editTheatreValue.trim();
    // Uppercase on the way out so a lowercase entry is accepted rather than
    // bounced; the route and the DB CHECK both reject anything else.
    const trimmedIso = editIsoValue.trim().toUpperCase();
    const res = await fetch(`/api/region-data/${encodeURIComponent(originalCountry)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        country: editCountryValue,
        region: editRegionValue,
        theatre: trimmedTheatre,
        isoCode: trimmedIso,
      }),
    });
    if (res.ok) {
      setRegions((prev) =>
        prev
          .map((r) =>
            r.country === originalCountry
              ? {
                  country: editCountryValue,
                  region: editRegionValue,
                  theatre: trimmedTheatre || null,
                  isoCode: trimmedIso || null,
                }
              : r
          )
          .sort((a, b) => a.country.localeCompare(b.country))
      );
      setEditingRegion(null);
    } else {
      setSaveError(await readError(res));
    }
  };

  // --- Suggest ISO codes (review queue) ---------------------------------
  // Name-matches the countries that have no code yet and presents the matches
  // for approval. It never writes: `applySuggestions` below only saves the rows
  // the admin has ticked.
  const openSuggest = async () => {
    setSuggestOpen(true);
    setSuggestError(null);
    setSuggestions(null);
    setUnmatched([]);
    setAccepted(new Set());
    setSuggestLoading(true);
    try {
      const { suggestIsoCode } = await import("@/lib/iso-countries");
      const matched: IsoSuggestionRow[] = [];
      const missed: string[] = [];
      for (const r of regions) {
        if (r.isoCode) continue;
        const hit = suggestIsoCode(r.country);
        if (hit) {
          matched.push({ country: r.country, region: r.region, ...hit });
        } else {
          missed.push(r.country);
        }
      }
      setSuggestions(matched);
      setUnmatched(missed);
      // Deliberately starts with nothing ticked. Pre-ticking would make
      // "apply" the path of least resistance, which is auto-apply wearing a
      // checkbox; "Select all" is one click away for whoever has read them.
    } catch {
      setSuggestError("Could not load the ISO country list. Please try again.");
    } finally {
      setSuggestLoading(false);
    }
  };

  const toggleAccepted = (country: string) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(country)) next.delete(country);
      else next.add(country);
      return next;
    });
  };

  const applySuggestions = async () => {
    if (!suggestions) return;
    const chosen = suggestions.filter((sg) => accepted.has(sg.country));
    if (chosen.length === 0) return;
    setApplying(true);
    setSuggestError(null);
    const failed: string[] = [];
    for (const sg of chosen) {
      try {
        const res = await fetch(`/api/region-data/${encodeURIComponent(sg.country)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          // region is required by the route; `theatre` is deliberately omitted
          // so the stored value is left alone.
          body: JSON.stringify({ region: sg.region, isoCode: sg.code }),
        });
        if (!res.ok) failed.push(sg.country);
      } catch {
        failed.push(sg.country);
      }
    }
    setApplying(false);
    if (failed.length > 0) {
      setSuggestError(
        `${failed.length} of ${chosen.length} could not be saved. The rest were applied.`
      );
    } else {
      setSuggestOpen(false);
      setSuggestions(null);
    }
    fetchRegions();
  };

  const handleDeleteRegion = async (country: string) => {
    const res = await fetch(`/api/region-data/${encodeURIComponent(country)}`, { method: "DELETE" });
    if (res.ok) setRegions((prev) => prev.filter((r) => r.country !== country));
  };

  // Import handlers
  const parseFile = (file: File) => {
    setImportError(null);
    setFileName(file.name);
    // Bound the input before it is buffered and parsed in this tab.
    const rejection = checkImportFile(file);
    if (rejection) {
      setImportError(rejection);
      return;
    }
    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "csv") {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (result) => {
          if (result.errors.length > 0) {
            setImportError(`Parse errors: ${result.errors.map((e) => e.message).join(", ")}`);
            return;
          }
          const hdrs = result.meta.fields || [];
          setHeaders(hdrs);
          setRows(result.data as Record<string, string>[]);
          autoMapColumns(hdrs);
          setImportStep("mapping");
        },
        error: (err) => setImportError(`Failed to parse CSV: ${err.message}`),
      });
    } else if (ext === "xls" || ext === "xlsx") {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: "array" });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const allRows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false });
          if (allRows.length < 2) { setImportError("No data found in file"); return; }
          const hdrs = (allRows[0] || []).map((h) => String(h).trim()).filter(Boolean);
          const jsonData = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { raw: false, defval: "" });
          setHeaders(hdrs);
          setRows(jsonData);
          autoMapColumns(hdrs);
          setImportStep("mapping");
        } catch (err) {
          setImportError(`Failed to parse Excel: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setImportError("Unsupported file type. Please upload a CSV or Excel file.");
    }
  };

  const autoMapColumns = (hdrs: string[]) => {
    const mapping: Record<string, string> = {};
    // Two folds, and both are needed. Keeping digits is what lets an
    // "ISO 3166-1" header resolve (letters-only collapses it to "iso"), but
    // keeping them ALONE silently narrows the three pre-existing fields: a
    // real-world "Theatre 3" or "Country 2" header folds to "theatre3" and
    // stops matching. For Country/Region that surfaces as the "please map the
    // following fields" error, but Theatre is optional, so it would import with
    // every row's theatre quietly unwritten. So: prefer the digit-preserving
    // fold, then fall back to the historic letters-only one.
    const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const letters = (value: string) => value.toLowerCase().replace(/[^a-z]/g, "");
    const claimed = new Set<string>();
    for (const field of TARGET_FIELDS) {
      const wanted = new Set([fold(field.label), ...field.aliases]);
      const legacy = new Set([letters(field.label), ...field.aliases.map(letters)]);
      const match =
        hdrs.find((h) => !claimed.has(h) && wanted.has(fold(h))) ??
        hdrs.find((h) => !claimed.has(h) && legacy.has(letters(h)));
      if (match) {
        mapping[field.key] = match;
        claimed.add(match);
      }
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
    const missingFields = TARGET_FIELDS.filter((f) => f.required && !columnMapping[f.key]);
    if (missingFields.length > 0) {
      setImportError(`Please map the following fields: ${missingFields.map((f) => f.label).join(", ")}`);
      return;
    }
    setImportStep("importing");
    setImportError(null);
    try {
      const res = await fetch("/api/region-data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, columnMapping }),
      });
      if (!res.ok) {
        const errorData = await res.json();
        setImportError(errorData.error || "Import failed");
        setImportStep("mapping");
        return;
      }
      const result = await res.json();
      setImportSummary(result);
      setImportStep("summary");
      fetchRegions();
      fetchLastImport();
    } catch (err) {
      setImportError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      setImportStep("mapping");
    }
  };

  const resetImport = () => {
    setImportStep("upload");
    setFileName("");
    setHeaders([]);
    setRows([]);
    setColumnMapping({});
    setImportSummary(null);
    setImportError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const closeImport = () => {
    setShowImport(false);
    resetImport();
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading region data...</div></div>;
  }

  return (
    <div>
      <PageHeader
        title="Region Data"
        showBack
        helpSlug="region-data"
        rightContent={lastImport && <span className="text-sm text-gray-500">Last imported: {new Date(lastImport).toLocaleString()}</span>}
      />

      {/* Toolbar */}
      <section className="mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
          >
            <Upload size={16} /> Import Region Data
          </button>
          <div className="relative">
            <button
              onClick={() => setShowExportMenu((prev) => !prev)}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              <Download size={16} /> Export
            </button>
            {showExportMenu && (
              <div className="absolute left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
                <button onClick={() => { exportToCsv(regions, EXPORT_COLUMNS, "region-data"); setShowExportMenu(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg">Export as CSV</button>
                <button onClick={() => { exportToExcel(regions, EXPORT_COLUMNS, "region-data"); setShowExportMenu(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100">Export as Excel</button>
                <button onClick={() => { exportToPdf(regions, EXPORT_COLUMNS, "region-data"); setShowExportMenu(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg">Export as PDF</button>
              </div>
            )}
          </div>
          <button
            onClick={openSuggest}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
          >
            <Wand2 size={16} /> Suggest ISO codes
          </button>
          <button
            onClick={() => setAddModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={16} /> Add
          </button>
        </div>
        {unmappedCount > 0 && (
          <p className="mt-3 text-sm text-amber-700">
            {unmappedCount} {unmappedCount === 1 ? "country has" : "countries have"} no ISO
            code. Unmapped countries cannot be matched to a map or to any other
            system that keys on ISO 3166-1.
          </p>
        )}
      </section>

      {/* Import Modal */}
      <Modal open={showImport} onClose={closeImport} title="Import Region Data" size="xl">
        <div>
          <div className="flex justify-end mb-3">
            <button
              onClick={() => {
                const csv =
                  "Country,Region,Theatre,ISO Code\nUnited States,Americas,AMER,US\nUnited Kingdom,EMEA,EMEA,GB";
                const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = "region-data-template.csv";
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              <Download size={14} /> Download Template
            </button>
          </div>

          {importError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <AlertCircle size={18} className="text-red-500 mt-0.5 shrink-0" />
              <span className="text-red-700 text-sm">{importError}</span>
            </div>
          )}

          {/* Step 1: Upload */}
          {importStep === "upload" && (
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              className="border-2 border-dashed border-gray-300 rounded-lg p-10 text-center hover:border-blue-400 transition-colors cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={40} className="mx-auto text-gray-400 mb-3" />
              <p className="text-base font-medium text-gray-700 mb-1">Drop your CSV or Excel file here</p>
              <p className="text-sm text-gray-500 mb-3">or click to browse files</p>
              <p className="text-xs text-gray-400">Supported formats: .csv, .xls, .xlsx</p>
              <input ref={fileInputRef} type="file" accept=".csv,.xls,.xlsx" onChange={handleFileSelect} className="hidden" />
            </div>
          )}

          {/* Step 2: Column Mapping */}
          {importStep === "mapping" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <FileSpreadsheet size={18} className="text-blue-500" />
                <span className="font-medium text-sm">{fileName}</span>
                <span className="text-xs text-gray-500">({rows.length} rows, {headers.length} columns)</span>
              </div>
              <div>
                <h4 className="text-sm font-semibold mb-3">Map Columns</h4>
                <p className="text-sm text-gray-600 mb-3">
                  Map the columns from your file to Country, Region, and (optionally)
                  Theatre and ISO Code. A column you leave unmapped is not written
                  at all, so the stored value is left exactly as it is.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {TARGET_FIELDS.map((field) => (
                    <div key={field.key} className="flex items-center gap-3 min-w-0">
                      <label className="w-20 shrink-0 text-sm font-medium text-gray-700">
                        {field.label}
                        {field.required && <span className="text-red-500 ml-1">*</span>}
                      </label>
                      <select
                        value={columnMapping[field.key] || ""}
                        onChange={(e) => setColumnMapping((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      >
                        <option value="">-- Select column --</option>
                        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
              {rows.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Preview (first 5 rows)</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border border-gray-200">
                      <thead>
                        <tr className="bg-gray-50">
                          {TARGET_FIELDS.map((f) => <th key={f.key} className="px-3 py-2 text-left border-b">{f.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 5).map((row, idx) => (
                          <tr key={idx} className="border-b">
                            {TARGET_FIELDS.map((f) => (
                              <td key={f.key} className="px-3 py-2 text-gray-600">
                                {columnMapping[f.key] ? row[columnMapping[f.key]] || "-" : <span className="text-gray-300 italic">not mapped</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div className="flex gap-3 pt-2">
                <button onClick={resetImport} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Back</button>
                <button onClick={handleImport} className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Import {rows.length} Rows</button>
              </div>
            </div>
          )}

          {/* Step 3: Importing */}
          {importStep === "importing" && (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mb-4" />
              <p className="text-gray-600">Importing {rows.length} rows...</p>
            </div>
          )}

          {/* Step 4: Summary */}
          {importStep === "summary" && importSummary && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <CheckCircle size={22} className="text-green-500" />
                <h4 className="text-base font-semibold">Import Complete</h4>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-green-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-green-700">{importSummary.imported}</div>
                  <div className="text-sm text-green-600">New Regions</div>
                </div>
                <div className="bg-blue-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-blue-700">{importSummary.updated}</div>
                  <div className="text-sm text-blue-600">Updated</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-gray-700">{importSummary.skipped}</div>
                  <div className="text-sm text-gray-600">Skipped</div>
                </div>
              </div>
              {importSummary.errors.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-red-700 mb-2">Errors ({importSummary.errors.length})</h4>
                  <div className="max-h-48 overflow-y-auto bg-red-50 rounded-lg p-3">
                    {importSummary.errors.map((err, idx) => <div key={idx} className="text-sm text-red-600 py-1">{err}</div>)}
                  </div>
                </div>
              )}
              <div className="flex gap-3 pt-2">
                <button onClick={closeImport} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Done</button>
                <button onClick={resetImport} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Import Another File</button>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* Add Region Modal */}
      <Modal
        open={addModalOpen}
        onClose={() => { setAddModalOpen(false); setSaveError(null); setNewCountry(""); setNewRegionValue(""); setNewTheatreValue(""); setNewIsoValue(""); }}
        title="Add Region"
        size="sm"
        actions={
          <>
            <button onClick={() => { setAddModalOpen(false); setSaveError(null); setNewCountry(""); setNewRegionValue(""); setNewTheatreValue(""); setNewIsoValue(""); }} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleAddRegion} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Add</button>
          </>
        }
      >
        <div className="space-y-3">
          {saveError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {saveError}
            </p>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">Country *</label>
            <input
              type="text"
              value={newCountry}
              onChange={(e) => setNewCountry(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. United States"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Region</label>
            <input
              type="text"
              value={newRegionValue}
              onChange={(e) => setNewRegionValue(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. Americas"
            />
            <p className="mt-1 text-xs text-gray-500">
              Leave blank if the country has no region yet.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Theatre</label>
            <input
              type="text"
              value={newTheatreValue}
              onChange={(e) => setNewTheatreValue(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. AMER"
            />
            <p className="mt-1 text-xs text-gray-500">
              Required before students can be assigned to this country.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">ISO Code</label>
            <input
              type="text"
              value={newIsoValue}
              onChange={(e) => setNewIsoValue(e.target.value.toUpperCase())}
              maxLength={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm uppercase"
              placeholder="e.g. US"
            />
            <p className="mt-1 text-xs text-gray-500">
              ISO 3166-1 alpha-2, two letters. Leave blank if this geography has
              no single country code — blank means unmapped, not zero.
            </p>
          </div>
        </div>
      </Modal>

      {/* Suggest ISO codes — a review queue, never an automatic write */}
      <Modal
        open={suggestOpen}
        onClose={() => { if (!applying) setSuggestOpen(false); }}
        title="Suggest ISO codes"
        size="xl"
        actions={
          <>
            <button
              onClick={() => setSuggestOpen(false)}
              disabled={applying}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={applySuggestions}
              disabled={applying || accepted.size === 0}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {applying ? "Applying..." : `Apply ${accepted.size} selected`}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            These are <strong>proposals</strong>, matched by country name against
            the ISO 3166-1 list. Nothing is saved until you tick a row and choose
            Apply. Check the matched name before accepting — a name match is a
            guess about your data, not a fact about it.
          </p>

          {suggestError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <AlertCircle size={18} className="text-red-500 mt-0.5 shrink-0" />
              <span className="text-red-700 text-sm">{suggestError}</span>
            </div>
          )}

          {suggestLoading && <p className="text-sm text-gray-500">Matching countries...</p>}

          {!suggestLoading && suggestions && suggestions.length === 0 && (
            <p className="text-sm text-gray-600">
              No suggestions. Every country either already has a code, or has no
              confident match in the ISO 3166-1 list.
            </p>
          )}

          {!suggestLoading && suggestions && suggestions.length > 0 && (
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h4 className="text-sm font-semibold">
                  {suggestions.length} suggested{" "}
                  {suggestions.length === 1 ? "code" : "codes"}
                </h4>
                <button
                  onClick={() => setAccepted(new Set(suggestions.map((sg) => sg.country)))}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Select all
                </button>
                <button
                  onClick={() => setAccepted(new Set())}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Select none
                </button>
              </div>
              <div className="max-h-80 overflow-y-auto border border-gray-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 w-10" />
                      <th className="px-3 py-2 text-left font-semibold text-gray-700">
                        Country (yours)
                      </th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-700">
                        Suggested
                      </th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-700">
                        Matched against
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.map((sg) => (
                      <tr key={sg.country} className="border-t">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={accepted.has(sg.country)}
                            onChange={() => toggleAccepted(sg.country)}
                            aria-label={`Accept ${sg.code} for ${sg.country}`}
                          />
                        </td>
                        <td className="px-3 py-2">{sg.country}</td>
                        <td className="px-3 py-2 font-mono">{sg.code}</td>
                        <td className="px-3 py-2 text-gray-600">{sg.matchedName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!suggestLoading && unmatched.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-amber-700 mb-1">
                No suggestion ({unmatched.length})
              </h4>
              <p className="text-xs text-gray-500 mb-2">
                No confident match, so nothing is proposed rather than a guess
                being offered. Set these by hand in the table.
              </p>
              <div className="max-h-40 overflow-y-auto bg-amber-50 rounded-lg p-3 text-sm text-amber-900">
                {unmatched.join(", ")}
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* Search and Filter (Training Data style) */}
      <section className="mb-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <select
          value={searchColumn}
          onChange={(e) => setSearchColumn(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All columns</option>
          <option value="country">Country</option>
          <option value="region">Region</option>
          <option value="theatre">Theatre</option>
          <option value="isoCode">ISO Code</option>
        </select>
      </section>

      {/* Region Data Table */}
      <section className="mb-8">
        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => handleSort("country")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      Country
                      {sortColumn === "country" && (sortDirection === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
                    </button>
                  </div>
                </th>
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => handleSort("region")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      Region
                      {sortColumn === "region" && (sortDirection === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
                    </button>
                    <select
                      value={regionFilter}
                      onChange={(e) => setRegionFilter(e.target.value)}
                      className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal"
                    >
                      <option value="">All</option>
                      {uniqueRegions.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                </th>
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => handleSort("theatre")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      Theatre
                      {sortColumn === "theatre" && (sortDirection === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
                    </button>
                    <select
                      value={theatreFilter}
                      onChange={(e) => setTheatreFilter(e.target.value)}
                      className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal"
                    >
                      <option value="">All</option>
                      <option value="__missing__">(missing)</option>
                      {uniqueTheatres.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </th>
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => handleSort("isoCode")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      ISO Code
                      {sortColumn === "isoCode" && (sortDirection === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
                    </button>
                    <select
                      value={isoFilter}
                      onChange={(e) => setIsoFilter(e.target.value)}
                      className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal"
                    >
                      <option value="">All</option>
                      <option value="__missing__">(missing)</option>
                      <option value="__mapped__">(mapped)</option>
                    </select>
                  </div>
                </th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRegions.map((r) => (
                <tr key={r.country} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-3">
                    {editingRegion === r.country ? (
                      <input type="text" value={editCountryValue} onChange={(e) => setEditCountryValue(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-sm w-full" />
                    ) : r.country}
                  </td>
                  <td className="px-4 py-3">
                    {editingRegion === r.country ? (
                      <input type="text" value={editRegionValue} onChange={(e) => setEditRegionValue(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-sm w-full" />
                    ) : r.region}
                  </td>
                  <td className="px-4 py-3">
                    {editingRegion === r.country ? (
                      <input
                        type="text"
                        value={editTheatreValue}
                        onChange={(e) => setEditTheatreValue(e.target.value)}
                        placeholder="e.g. AMER"
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                      />
                    ) : r.theatre ? (
                      r.theatre
                    ) : (
                      <span className="text-amber-600 text-xs">(missing)</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {editingRegion === r.country ? (
                      <input
                        type="text"
                        value={editIsoValue}
                        onChange={(e) => setEditIsoValue(e.target.value.toUpperCase())}
                        maxLength={2}
                        placeholder="e.g. US"
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-full uppercase"
                      />
                    ) : r.isoCode ? (
                      <span className="font-mono">{r.isoCode}</span>
                    ) : (
                      <span className="text-amber-600 text-xs">(unmapped)</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      {editingRegion === r.country ? (
                        <>
                          <button onClick={() => handleUpdateRegion(r.country)} className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200"><Save size={14} /></button>
                          <button onClick={() => setEditingRegion(null)} className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200">Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => { setEditingRegion(r.country); setEditCountryValue(r.country); setEditRegionValue(r.region); setEditTheatreValue(r.theatre ?? ""); setEditIsoValue(r.isoCode ?? ""); }} className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">Edit</button>
                          <button onClick={() => handleDeleteRegion(r.country)} className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"><Trash2 size={14} /></button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredRegions.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">No records found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
