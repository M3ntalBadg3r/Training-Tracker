"use client";

import { Suspense, useEffect, useState, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import { Search, Download, ChevronDown, ChevronRight } from "lucide-react";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";

interface TrainedNotCertifiedRow {
  fullName: string;
  email: string;
  theatre: string;
  region: string;
  country: string;
  iltFullTitle: string;
  iltProductType: string;
  certificationFullTitle: string;
  iltCompletedDate: string;
  iltActive: boolean;
}

interface TrainingRecordRow {
  fullName: string;
  email: string;
  theatre: string;
  country: string;
  trainingTitle: string;
  trainingType: string;
  productType: string;
  function: string;
  completedDate: string;
  expiryDate: string;
  active: boolean;
}

function ExportMenu({
  data,
  columns,
  filename,
}: {
  data: Record<string, unknown>[];
  columns: { key: string; header: string }[];
  filename: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setShow((prev) => !prev)}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
      >
        <Download size={16} /> Export
      </button>
      {show && (
        <div className="absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
          <button
            onClick={() => { exportToCsv(data, columns as never, filename); setShow(false); }}
            className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg"
          >
            Export as CSV
          </button>
          <button
            onClick={() => { exportToExcel(data, columns as never, filename); setShow(false); }}
            className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
          >
            Export as Excel
          </button>
          <button
            onClick={() => { exportToPdf(data, columns as never, filename); setShow(false); }}
            className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg"
          >
            Export as PDF
          </button>
        </div>
      )}
    </div>
  );
}

function ReportsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const openReport = searchParams.get("report");

  // Trained but not Certified report
  const [reportData, setReportData] = useState<TrainedNotCertifiedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reportOpen, setReportOpen] = useState(!openReport || openReport === "trained-not-certified");

  // Training records data (for the 4 dashboard-linked reports)
  const [trainingRecords, setTrainingRecords] = useState<TrainingRecordRow[]>([]);
  const [trLoading, setTrLoading] = useState(true);

  // Report open states
  const [productTypeOpen, setProductTypeOpen] = useState(openReport === "by-product-type");
  const [functionOpen, setFunctionOpen] = useState(openReport === "by-function");
  const [expiringOpen, setExpiringOpen] = useState(openReport === "expiring");
  const [achievedOpen, setAchievedOpen] = useState(openReport === "achieved");

  // Filters for Trained but not Certified
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTheatre, setFilterTheatre] = useState("");
  const [filterRegion, setFilterRegion] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [filterProduct, setFilterProduct] = useState("");
  const [filterIlt, setFilterIlt] = useState("");
  const [filterCert, setFilterCert] = useState("");
  const [filterActive, setFilterActive] = useState("");

  // Filters for Product Type report
  const [ptSearch, setPtSearch] = useState("");
  const [ptProduct, setPtProduct] = useState("");
  const [ptType, setPtType] = useState("");
  const [ptTheatre, setPtTheatre] = useState("");

  // Filters for Function report
  const [fnSearch, setFnSearch] = useState("");
  const [fnFunction, setFnFunction] = useState("");
  const [fnType, setFnType] = useState("");
  const [fnTheatre, setFnTheatre] = useState("");

  // Filters for Expiring report
  const [expSearch, setExpSearch] = useState("");
  const [expWindow, setExpWindow] = useState("6");
  const [expType, setExpType] = useState("");
  const [expTheatre, setExpTheatre] = useState("");

  // Filters for Achieved report
  const [achSearch, setAchSearch] = useState("");
  const [achType, setAchType] = useState("");
  const [achTheatre, setAchTheatre] = useState("");

  // Refs for scrolling
  const productTypeRef = useRef<HTMLElement>(null);
  const functionRef = useRef<HTMLElement>(null);
  const expiringRef = useRef<HTMLElement>(null);
  const achievedRef = useRef<HTMLElement>(null);

  useEffect(() => {
    fetch("/api/reports/trained-not-certified")
      .then((r) => r.json())
      .then((data) => {
        setReportData(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    fetch("/api/reports/training-records")
      .then((r) => r.json())
      .then((data) => {
        setTrainingRecords(data);
        setTrLoading(false);
      })
      .catch(() => setTrLoading(false));
  }, []);

  // Auto-scroll to the targeted report
  useEffect(() => {
    if (!trLoading && openReport) {
      const refMap: Record<string, React.RefObject<HTMLElement | null>> = {
        "by-product-type": productTypeRef,
        "by-function": functionRef,
        expiring: expiringRef,
        achieved: achievedRef,
      };
      const ref = refMap[openReport];
      if (ref?.current) {
        ref.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }, [trLoading, openReport]);

  // === Trained but not Certified filters ===
  const theatres = useMemo(() => [...new Set(reportData.map((r) => r.theatre))].filter(Boolean).sort(), [reportData]);
  const regions = useMemo(() => [...new Set(reportData.map((r) => r.region))].filter(Boolean).sort(), [reportData]);
  const countries = useMemo(() => [...new Set(reportData.map((r) => r.country))].filter(Boolean).sort(), [reportData]);
  const productTypes = useMemo(() => [...new Set(reportData.map((r) => r.iltProductType))].filter(Boolean).sort(), [reportData]);
  const iltTitles = useMemo(() => [...new Set(reportData.map((r) => r.iltFullTitle))].sort(), [reportData]);
  const certTitles = useMemo(() => [...new Set(reportData.map((r) => r.certificationFullTitle))].sort(), [reportData]);

  const filteredData = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return reportData.filter((r) => {
      const matchesSearch = !searchQuery || r.fullName.toLowerCase().includes(q) || r.email.toLowerCase().includes(q);
      const matchesTheatre = !filterTheatre || r.theatre === filterTheatre;
      const matchesRegion = !filterRegion || r.region === filterRegion;
      const matchesCountry = !filterCountry || r.country === filterCountry;
      const matchesProduct = !filterProduct || r.iltProductType === filterProduct;
      const matchesIlt = !filterIlt || r.iltFullTitle === filterIlt;
      const matchesCert = !filterCert || r.certificationFullTitle === filterCert;
      const matchesActive = !filterActive || (filterActive === "yes" ? r.iltActive : !r.iltActive);
      return matchesSearch && matchesTheatre && matchesRegion && matchesCountry && matchesProduct && matchesIlt && matchesCert && matchesActive;
    });
  }, [reportData, searchQuery, filterTheatre, filterRegion, filterCountry, filterProduct, filterIlt, filterCert, filterActive]);

  const tncExportData = useMemo(
    () => filteredData.map((r) => ({ ...r, iltCompletedDate: new Date(r.iltCompletedDate).toLocaleDateString(), iltActive: r.iltActive ? "Yes" : "No" })),
    [filteredData]
  );

  const tncExportColumns = [
    { key: "fullName", header: "Full Name" },
    { key: "email", header: "Email Address" },
    { key: "theatre", header: "Theatre" },
    { key: "region", header: "Region" },
    { key: "country", header: "Country" },
    { key: "iltFullTitle", header: "Instructor-Led Training" },
    { key: "iltProductType", header: "Product" },
    { key: "iltCompletedDate", header: "ILT Completed Date" },
    { key: "iltActive", header: "ILT Active" },
    { key: "certificationFullTitle", header: "Certification Not Obtained" },
  ];

  // === Training record helpers ===
  const trTheatres = useMemo(() => [...new Set(trainingRecords.map((r) => r.theatre))].filter(Boolean).sort(), [trainingRecords]);
  const trProductTypes = useMemo(() => [...new Set(trainingRecords.map((r) => r.productType))].filter(Boolean).sort(), [trainingRecords]);
  const trTypes = useMemo(() => [...new Set(trainingRecords.map((r) => r.trainingType))].filter(Boolean).sort(), [trainingRecords]);
  const trFunctions = useMemo(() => [...new Set(trainingRecords.map((r) => r.function))].filter(Boolean).sort(), [trainingRecords]);

  const now = useMemo(() => new Date(), []);

  // By Product Type filtered data
  const ptFiltered = useMemo(() => {
    const q = ptSearch.toLowerCase();
    return trainingRecords.filter((r) => {
      if (ptSearch && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (ptProduct && r.productType !== ptProduct) return false;
      if (ptType && r.trainingType !== ptType) return false;
      if (ptTheatre && r.theatre !== ptTheatre) return false;
      return true;
    });
  }, [trainingRecords, ptSearch, ptProduct, ptType, ptTheatre]);

  // By Function filtered data
  const fnFiltered = useMemo(() => {
    const q = fnSearch.toLowerCase();
    return trainingRecords.filter((r) => {
      if (fnSearch && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (fnFunction && r.function !== fnFunction) return false;
      if (fnType && r.trainingType !== fnType) return false;
      if (fnTheatre && r.theatre !== fnTheatre) return false;
      return true;
    });
  }, [trainingRecords, fnSearch, fnFunction, fnType, fnTheatre]);

  // Expiring filtered data
  const expFiltered = useMemo(() => {
    const q = expSearch.toLowerCase();
    const windowMonths = parseInt(expWindow);
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() + windowMonths);
    return trainingRecords.filter((r) => {
      const expiry = new Date(r.expiryDate);
      if (expiry <= now || expiry > cutoff) return false;
      if (expSearch && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (expType && r.trainingType !== expType) return false;
      if (expTheatre && r.theatre !== expTheatre) return false;
      return true;
    });
  }, [trainingRecords, expSearch, expWindow, expType, expTheatre, now]);

  // Achieved over last 12 months filtered data
  const achFiltered = useMemo(() => {
    const q = achSearch.toLowerCase();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    return trainingRecords.filter((r) => {
      const completed = new Date(r.completedDate);
      if (completed < twelveMonthsAgo || completed > now) return false;
      if (achSearch && !r.fullName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      if (achType && r.trainingType !== achType) return false;
      if (achTheatre && r.theatre !== achTheatre) return false;
      return true;
    });
  }, [trainingRecords, achSearch, achType, achTheatre, now]);

  // Export columns for training records
  const trExportColumns = [
    { key: "fullName", header: "Full Name" },
    { key: "email", header: "Email" },
    { key: "theatre", header: "Theatre" },
    { key: "country", header: "Country" },
    { key: "trainingTitle", header: "Training" },
    { key: "trainingType", header: "Training Type" },
    { key: "productType", header: "Product Type" },
    { key: "function", header: "Function" },
    { key: "completedDate", header: "Completed Date" },
    { key: "expiryDate", header: "Expiry Date" },
    { key: "active", header: "Active" },
  ];

  const formatExportRows = (rows: TrainingRecordRow[]) =>
    rows.map((r) => ({
      ...r,
      completedDate: new Date(r.completedDate).toLocaleDateString(),
      expiryDate: new Date(r.expiryDate).toLocaleDateString(),
      active: r.active ? "Yes" : "No",
    }));

  if (loading || trLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading reports...</div>
      </div>
    );
  }

  const renderTrainingTable = (rows: TrainingRecordRow[]) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b">
            <th className="px-4 py-3 text-left font-semibold">Full Name</th>
            <th className="px-4 py-3 text-left font-semibold">Email</th>
            <th className="px-4 py-3 text-left font-semibold">Theatre</th>
            <th className="px-4 py-3 text-left font-semibold">Country</th>
            <th className="px-4 py-3 text-left font-semibold">Training</th>
            <th className="px-4 py-3 text-left font-semibold">Type</th>
            <th className="px-4 py-3 text-left font-semibold">Product</th>
            <th className="px-4 py-3 text-left font-semibold">Function</th>
            <th className="px-4 py-3 text-left font-semibold">Completed</th>
            <th className="px-4 py-3 text-left font-semibold">Expires</th>
            <th className="px-4 py-3 text-left font-semibold">Active</th>
            <th className="px-4 py-3 text-left font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={`${row.email}-${row.trainingTitle}-${idx}`} className="border-b hover:bg-gray-50">
              <td className="px-4 py-3">{row.fullName}</td>
              <td className="px-4 py-3">{row.email}</td>
              <td className="px-4 py-3">{row.theatre || "-"}</td>
              <td className="px-4 py-3">{row.country || "-"}</td>
              <td className="px-4 py-3">{row.trainingTitle}</td>
              <td className="px-4 py-3">
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                  row.trainingType === "Certification" ? "bg-blue-100 text-blue-800" :
                  row.trainingType === "Accreditation" ? "bg-emerald-100 text-emerald-800" :
                  "bg-amber-100 text-amber-800"
                }`}>
                  {row.trainingType}
                </span>
              </td>
              <td className="px-4 py-3">{row.productType}</td>
              <td className="px-4 py-3">{row.function}</td>
              <td className="px-4 py-3">{new Date(row.completedDate).toLocaleDateString()}</td>
              <td className="px-4 py-3">{new Date(row.expiryDate).toLocaleDateString()}</td>
              <td className="px-4 py-3">
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${row.active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
                  {row.active ? "Yes" : "No"}
                </span>
              </td>
              <td className="px-4 py-3">
                <button
                  onClick={() => router.push(`/students/${encodeURIComponent(row.email)}`)}
                  className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                >
                  View
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={12} className="px-4 py-8 text-center text-gray-500">
                No results match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <PageHeader title="Reports" helpSlug="reports" />

      {/* Report: By Product Type */}
      <section ref={productTypeRef} className="mb-6">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setProductTypeOpen((prev) => !prev)}
            className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-gray-50 transition-colors"
          >
            {productTypeOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <div>
              <h2 className="text-lg font-semibold text-gray-900">By Product Type</h2>
              <p className="text-sm text-gray-500">All training records broken down by product type</p>
            </div>
            <span className="ml-auto text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
              {ptFiltered.length} result{ptFiltered.length !== 1 ? "s" : ""}
            </span>
          </button>
          {productTypeOpen && (
            <div className="border-t border-gray-200 px-6 py-4">
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="relative flex-1">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input type="text" placeholder="Search by name or email..." value={ptSearch} onChange={(e) => setPtSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
                  </div>
                  <ExportMenu data={formatExportRows(ptFiltered) as never} columns={trExportColumns} filename="by-product-type" />
                </div>
                <div className="flex flex-wrap gap-3">
                  <select value={ptProduct} onChange={(e) => setPtProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Products</option>
                    {trProductTypes.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <select value={ptType} onChange={(e) => setPtType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Types</option>
                    {trTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={ptTheatre} onChange={(e) => setPtTheatre(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Theatres</option>
                    {trTheatres.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              {renderTrainingTable(ptFiltered)}
              {ptFiltered.length > 0 && ptFiltered.length !== trainingRecords.length && (
                <div className="mt-3 text-sm text-gray-500">Showing {ptFiltered.length} of {trainingRecords.length} records</div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Report: By Function */}
      <section ref={functionRef} className="mb-6">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setFunctionOpen((prev) => !prev)}
            className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-gray-50 transition-colors"
          >
            {functionOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <div>
              <h2 className="text-lg font-semibold text-gray-900">By Function</h2>
              <p className="text-sm text-gray-500">All training records broken down by function (Sales, Pre-Sales, Deployments)</p>
            </div>
            <span className="ml-auto text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
              {fnFiltered.length} result{fnFiltered.length !== 1 ? "s" : ""}
            </span>
          </button>
          {functionOpen && (
            <div className="border-t border-gray-200 px-6 py-4">
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="relative flex-1">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input type="text" placeholder="Search by name or email..." value={fnSearch} onChange={(e) => setFnSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
                  </div>
                  <ExportMenu data={formatExportRows(fnFiltered) as never} columns={trExportColumns} filename="by-function" />
                </div>
                <div className="flex flex-wrap gap-3">
                  <select value={fnFunction} onChange={(e) => setFnFunction(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Functions</option>
                    {trFunctions.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <select value={fnType} onChange={(e) => setFnType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Types</option>
                    {trTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={fnTheatre} onChange={(e) => setFnTheatre(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Theatres</option>
                    {trTheatres.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              {renderTrainingTable(fnFiltered)}
              {fnFiltered.length > 0 && fnFiltered.length !== trainingRecords.length && (
                <div className="mt-3 text-sm text-gray-500">Showing {fnFiltered.length} of {trainingRecords.length} records</div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Report: Expiring Soon */}
      <section ref={expiringRef} className="mb-6">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setExpiringOpen((prev) => !prev)}
            className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-gray-50 transition-colors"
          >
            {expiringOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Expiring Soon</h2>
              <p className="text-sm text-gray-500">Training records expiring within the next 1, 3, or 6 months</p>
            </div>
            <span className="ml-auto text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
              {expFiltered.length} result{expFiltered.length !== 1 ? "s" : ""}
            </span>
          </button>
          {expiringOpen && (
            <div className="border-t border-gray-200 px-6 py-4">
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="relative flex-1">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input type="text" placeholder="Search by name or email..." value={expSearch} onChange={(e) => setExpSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
                  </div>
                  <ExportMenu data={formatExportRows(expFiltered) as never} columns={trExportColumns} filename="expiring-soon" />
                </div>
                <div className="flex flex-wrap gap-3">
                  <select value={expWindow} onChange={(e) => setExpWindow(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="1">Within 1 Month</option>
                    <option value="3">Within 3 Months</option>
                    <option value="6">Within 6 Months</option>
                  </select>
                  <select value={expType} onChange={(e) => setExpType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Types</option>
                    {trTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={expTheatre} onChange={(e) => setExpTheatre(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Theatres</option>
                    {trTheatres.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              {renderTrainingTable(expFiltered)}
              {expFiltered.length > 0 && (
                <div className="mt-3 text-sm text-gray-500">Showing {expFiltered.length} records expiring within {expWindow} month{expWindow !== "1" ? "s" : ""}</div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Report: Achieved Over Last 12 Months */}
      <section ref={achievedRef} className="mb-6">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setAchievedOpen((prev) => !prev)}
            className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-gray-50 transition-colors"
          >
            {achievedOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Achieved Over Last 12 Months</h2>
              <p className="text-sm text-gray-500">Training records completed in the last 12 months</p>
            </div>
            <span className="ml-auto text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
              {achFiltered.length} result{achFiltered.length !== 1 ? "s" : ""}
            </span>
          </button>
          {achievedOpen && (
            <div className="border-t border-gray-200 px-6 py-4">
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="relative flex-1">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input type="text" placeholder="Search by name or email..." value={achSearch} onChange={(e) => setAchSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
                  </div>
                  <ExportMenu data={formatExportRows(achFiltered) as never} columns={trExportColumns} filename="achieved-last-12-months" />
                </div>
                <div className="flex flex-wrap gap-3">
                  <select value={achType} onChange={(e) => setAchType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Types</option>
                    {trTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={achTheatre} onChange={(e) => setAchTheatre(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Theatres</option>
                    {trTheatres.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              {renderTrainingTable(achFiltered)}
              {achFiltered.length > 0 && (
                <div className="mt-3 text-sm text-gray-500">Showing {achFiltered.length} records from the last 12 months</div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Report: Trained but not Certified */}
      <section className="mb-8">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setReportOpen((prev) => !prev)}
            className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-gray-50 transition-colors"
          >
            {reportOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Trained but not Certified</h2>
              <p className="text-sm text-gray-500">Students who completed an Instructor-Led Training but haven&apos;t obtained the associated Certification</p>
            </div>
            <span className="ml-auto text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
              {reportData.length} result{reportData.length !== 1 ? "s" : ""}
            </span>
          </button>

          {reportOpen && (
            <div className="border-t border-gray-200 px-6 py-4">
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="relative flex-1">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input type="text" placeholder="Search by name or email..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
                  </div>
                  <ExportMenu data={tncExportData as never} columns={tncExportColumns} filename="trained-not-certified" />
                </div>
                <div className="flex flex-wrap gap-3">
                  <select value={filterTheatre} onChange={(e) => setFilterTheatre(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Theatres</option>
                    {theatres.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={filterRegion} onChange={(e) => setFilterRegion(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Regions</option>
                    {regions.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <select value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Countries</option>
                    {countries.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Products</option>
                    {productTypes.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <select value={filterIlt} onChange={(e) => setFilterIlt(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Trainings</option>
                    {iltTitles.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={filterCert} onChange={(e) => setFilterCert(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Certifications</option>
                    {certTitles.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <select value={filterActive} onChange={(e) => setFilterActive(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">All Active Status</option>
                    <option value="yes">Active</option>
                    <option value="no">Not Active</option>
                  </select>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-4 py-3 text-left font-semibold">Full Name</th>
                      <th className="px-4 py-3 text-left font-semibold">Email Address</th>
                      <th className="px-4 py-3 text-left font-semibold">Theatre</th>
                      <th className="px-4 py-3 text-left font-semibold">Region</th>
                      <th className="px-4 py-3 text-left font-semibold">Country</th>
                      <th className="px-4 py-3 text-left font-semibold">Instructor-Led Training</th>
                      <th className="px-4 py-3 text-left font-semibold">Product</th>
                      <th className="px-4 py-3 text-left font-semibold">ILT Completed Date</th>
                      <th className="px-4 py-3 text-left font-semibold">ILT Active</th>
                      <th className="px-4 py-3 text-left font-semibold">Certification Not Obtained</th>
                      <th className="px-4 py-3 text-left font-semibold"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredData.map((row, idx) => (
                      <tr key={`${row.email}-${row.iltFullTitle}-${idx}`} className="border-b hover:bg-gray-50">
                        <td className="px-4 py-3">{row.fullName}</td>
                        <td className="px-4 py-3">{row.email}</td>
                        <td className="px-4 py-3">{row.theatre || "-"}</td>
                        <td className="px-4 py-3">{row.region || "-"}</td>
                        <td className="px-4 py-3">{row.country || "-"}</td>
                        <td className="px-4 py-3">{row.iltFullTitle}</td>
                        <td className="px-4 py-3">{row.iltProductType}</td>
                        <td className="px-4 py-3">{new Date(row.iltCompletedDate).toLocaleDateString()}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${row.iltActive ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
                            {row.iltActive ? "Yes" : "No"}
                          </span>
                        </td>
                        <td className="px-4 py-3">{row.certificationFullTitle}</td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => router.push(`/students/${encodeURIComponent(row.email)}`)}
                            className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                    {filteredData.length === 0 && (
                      <tr>
                        <td colSpan={11} className="px-4 py-8 text-center text-gray-500">
                          {reportData.length === 0
                            ? "No results found. Ensure ILT trainings have certification mappings in Training Data."
                            : "No results match the current filters."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {filteredData.length > 0 && filteredData.length !== reportData.length && (
                <div className="mt-3 text-sm text-gray-500">
                  Showing {filteredData.length} of {reportData.length} results
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading reports...</div></div>}>
      <ReportsContent />
    </Suspense>
  );
}
