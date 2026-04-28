"use client";

import { useEffect, useState, useRef, useMemo } from "react";
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
} from "lucide-react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";

const TARGET_FIELDS = [
  { key: "country", label: "Country", required: true },
  { key: "region", label: "Region", required: true },
];

type ImportStep = "upload" | "mapping" | "importing" | "summary";

interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export default function RegionDataPage() {
  const [regions, setRegions] = useState<RegionDataRow[]>([]);
  const [editingRegion, setEditingRegion] = useState<string | null>(null);
  const [editCountryValue, setEditCountryValue] = useState("");
  const [editRegionValue, setEditRegionValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Search and filter state (Training Data style)
  const [searchTerm, setSearchTerm] = useState("");
  const [searchColumn, setSearchColumn] = useState("all");
  const [regionFilter, setRegionFilter] = useState("");
  const [sortColumn, setSortColumn] = useState<"country" | "region">("country");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  // Add modal state
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newCountry, setNewCountry] = useState("");
  const [newRegionValue, setNewRegionValue] = useState("");

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

  const uniqueRegions = useMemo(
    () => [...new Set(regions.map((r) => r.region))].sort(),
    [regions]
  );

  const filteredRegions = useMemo(() => {
    let result = [...regions];

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter((r) => {
        if (searchColumn === "country") return r.country.toLowerCase().includes(term);
        if (searchColumn === "region") return r.region.toLowerCase().includes(term);
        return r.country.toLowerCase().includes(term) || r.region.toLowerCase().includes(term);
      });
    }

    if (regionFilter) {
      result = result.filter((r) => r.region === regionFilter);
    }

    result.sort((a, b) => {
      const aVal = sortColumn === "country" ? a.country : a.region;
      const bVal = sortColumn === "country" ? b.country : b.region;
      const cmp = aVal.localeCompare(bVal);
      return sortDirection === "asc" ? cmp : -cmp;
    });

    return result;
  }, [regions, searchTerm, searchColumn, regionFilter, sortColumn, sortDirection]);

  const handleSort = (col: "country" | "region") => {
    if (sortColumn === col) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(col);
      setSortDirection("asc");
    }
  };

  const fetchLastImport = () => {
    fetch("/api/import-metadata?key=region-data")
      .then((res) => res.json())
      .then((data) => { if (data?.timestamp) setLastImport(data.timestamp); })
      .catch(() => {});
  };

  useEffect(() => {
    fetchRegions();
    fetchLastImport();
  }, []);

  const fetchRegions = () => {
    fetch("/api/region-data")
      .then((r) => r.json())
      .then((data) => { setRegions(data); setLoading(false); })
      .catch(() => setLoading(false));
  };

  const handleAddRegion = async () => {
    if (!newCountry || !newRegionValue) return;
    const res = await fetch("/api/region-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country: newCountry, region: newRegionValue }),
    });
    if (res.ok) {
      setAddModalOpen(false);
      setNewCountry("");
      setNewRegionValue("");
      fetchRegions();
    }
  };

  const handleUpdateRegion = async (originalCountry: string) => {
    const res = await fetch(`/api/region-data/${encodeURIComponent(originalCountry)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country: editCountryValue, region: editRegionValue }),
    });
    if (res.ok) {
      setRegions((prev) =>
        prev
          .map((r) => r.country === originalCountry ? { country: editCountryValue, region: editRegionValue } : r)
          .sort((a, b) => a.country.localeCompare(b.country))
      );
      setEditingRegion(null);
    }
  };

  const handleDeleteRegion = async (country: string) => {
    const res = await fetch(`/api/region-data/${encodeURIComponent(country)}`, { method: "DELETE" });
    if (res.ok) setRegions((prev) => prev.filter((r) => r.country !== country));
  };

  // Import handlers
  const parseFile = (file: File) => {
    setImportError(null);
    setFileName(file.name);
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
    for (const field of TARGET_FIELDS) {
      const match = hdrs.find(
        (h) => h.toLowerCase().replace(/[^a-z]/g, "") === field.label.toLowerCase().replace(/[^a-z]/g, "")
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
                <button onClick={() => { exportToCsv(regions, [{ key: "country", header: "Country" }, { key: "region", header: "Region" }], "region-data"); setShowExportMenu(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg">Export as CSV</button>
                <button onClick={() => { exportToExcel(regions, [{ key: "country", header: "Country" }, { key: "region", header: "Region" }], "region-data"); setShowExportMenu(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100">Export as Excel</button>
                <button onClick={() => { exportToPdf(regions, [{ key: "country", header: "Country" }, { key: "region", header: "Region" }], "region-data"); setShowExportMenu(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg">Export as PDF</button>
              </div>
            )}
          </div>
          <button
            onClick={() => setAddModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={16} /> Add
          </button>
        </div>
      </section>

      {/* Import Modal */}
      <Modal open={showImport} onClose={closeImport} title="Import Region Data" size="xl">
        <div>
          <div className="flex justify-end mb-3">
            <button
              onClick={() => {
                const csv = "Country,Region\nUnited States,Americas\nUnited Kingdom,EMEA";
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
                <p className="text-sm text-gray-600 mb-3">Map the columns from your file to Country and Region.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {TARGET_FIELDS.map((field) => (
                    <div key={field.key} className="flex items-center gap-3">
                      <label className="w-20 text-sm font-medium text-gray-700">{field.label}<span className="text-red-500 ml-1">*</span></label>
                      <select
                        value={columnMapping[field.key] || ""}
                        onChange={(e) => setColumnMapping((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
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
        onClose={() => { setAddModalOpen(false); setNewCountry(""); setNewRegionValue(""); }}
        title="Add Region"
        size="sm"
        actions={
          <>
            <button onClick={() => { setAddModalOpen(false); setNewCountry(""); setNewRegionValue(""); }} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleAddRegion} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Add</button>
          </>
        }
      >
        <div className="space-y-3">
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
            <label className="block text-sm font-medium mb-1">Region *</label>
            <input
              type="text"
              value={newRegionValue}
              onChange={(e) => setNewRegionValue(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. Americas"
            />
          </div>
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
        </select>
      </section>

      {/* Region Data Table */}
      <section className="mb-8">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
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
                    <div className="flex gap-2">
                      {editingRegion === r.country ? (
                        <>
                          <button onClick={() => handleUpdateRegion(r.country)} className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200"><Save size={14} /></button>
                          <button onClick={() => setEditingRegion(null)} className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200">Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => { setEditingRegion(r.country); setEditCountryValue(r.country); setEditRegionValue(r.region); }} className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">Edit</button>
                          <button onClick={() => handleDeleteRegion(r.country)} className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"><Trash2 size={14} /></button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredRegions.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-8 text-center text-gray-500">No records found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
