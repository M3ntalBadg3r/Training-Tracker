"use client";

import { useEffect, useState, useMemo } from "react";
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
  certificationFullTitle: string;
  iltCompletedDate: string;
  iltActive: boolean;
}

export default function ReportsPage() {
  // Trained but not Certified report
  const [reportData, setReportData] = useState<TrainedNotCertifiedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reportOpen, setReportOpen] = useState(true);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTheatre, setFilterTheatre] = useState("");
  const [filterRegion, setFilterRegion] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [filterIlt, setFilterIlt] = useState("");
  const [filterCert, setFilterCert] = useState("");

  const [showExportMenu, setShowExportMenu] = useState(false);

  useEffect(() => {
    fetch("/api/reports/trained-not-certified")
      .then((r) => r.json())
      .then((data) => {
        setReportData(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const theatres = useMemo(
    () => [...new Set(reportData.map((r) => r.theatre))].filter(Boolean).sort(),
    [reportData]
  );
  const regions = useMemo(
    () => [...new Set(reportData.map((r) => r.region))].filter(Boolean).sort(),
    [reportData]
  );
  const countries = useMemo(
    () => [...new Set(reportData.map((r) => r.country))].filter(Boolean).sort(),
    [reportData]
  );
  const iltTitles = useMemo(
    () => [...new Set(reportData.map((r) => r.iltFullTitle))].sort(),
    [reportData]
  );
  const certTitles = useMemo(
    () => [...new Set(reportData.map((r) => r.certificationFullTitle))].sort(),
    [reportData]
  );

  const filteredData = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return reportData.filter((r) => {
      const matchesSearch =
        !searchQuery ||
        r.fullName.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q);
      const matchesTheatre = !filterTheatre || r.theatre === filterTheatre;
      const matchesRegion = !filterRegion || r.region === filterRegion;
      const matchesCountry = !filterCountry || r.country === filterCountry;
      const matchesIlt = !filterIlt || r.iltFullTitle === filterIlt;
      const matchesCert = !filterCert || r.certificationFullTitle === filterCert;
      return matchesSearch && matchesTheatre && matchesRegion && matchesCountry && matchesIlt && matchesCert;
    });
  }, [reportData, searchQuery, filterTheatre, filterRegion, filterCountry, filterIlt, filterCert]);

  const exportData = useMemo(
    () =>
      filteredData.map((r) => ({
        ...r,
        iltCompletedDate: new Date(r.iltCompletedDate).toLocaleDateString(),
        iltActive: r.iltActive ? "Yes" : "No",
      })),
    [filteredData]
  );

  const exportColumns: { key: keyof typeof exportData[0]; header: string }[] = [
    { key: "fullName", header: "Full Name" },
    { key: "email", header: "Email Address" },
    { key: "theatre", header: "Theatre" },
    { key: "region", header: "Region" },
    { key: "country", header: "Country" },
    { key: "iltFullTitle", header: "Instructor-Led Training" },
    { key: "iltCompletedDate", header: "ILT Completed Date" },
    { key: "iltActive", header: "ILT Active" },
    { key: "certificationFullTitle", header: "Certification Not Obtained" },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading reports...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Reports" helpSlug="reports" />

      {/* Report: Trained but not Certified */}
      <section className="mb-8">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {/* Report Header */}
          <button
            onClick={() => setReportOpen((prev) => !prev)}
            className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-gray-50 transition-colors"
          >
            {reportOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Trained but not Certified</h2>
              <p className="text-sm text-gray-500">
                Students who completed an Instructor-Led Training but haven&apos;t obtained the associated Certification
              </p>
            </div>
            <span className="ml-auto text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
              {reportData.length} result{reportData.length !== 1 ? "s" : ""}
            </span>
          </button>

          {reportOpen && (
            <div className="border-t border-gray-200 px-6 py-4">
              {/* Search, Filters, and Export */}
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="relative flex-1">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      placeholder="Search by name or email..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg"
                    />
                  </div>
                  <div className="relative">
                    <button
                      onClick={() => setShowExportMenu((prev) => !prev)}
                      className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
                    >
                      <Download size={16} /> Export
                    </button>
                    {showExportMenu && (
                      <div className="absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
                        <button
                          onClick={() => {
                            exportToCsv(exportData, exportColumns, "trained-not-certified");
                            setShowExportMenu(false);
                          }}
                          className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg"
                        >
                          Export as CSV
                        </button>
                        <button
                          onClick={() => {
                            exportToExcel(exportData, exportColumns, "trained-not-certified");
                            setShowExportMenu(false);
                          }}
                          className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
                        >
                          Export as Excel
                        </button>
                        <button
                          onClick={() => {
                            exportToPdf(exportData, exportColumns, "trained-not-certified");
                            setShowExportMenu(false);
                          }}
                          className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg"
                        >
                          Export as PDF
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <select
                    value={filterTheatre}
                    onChange={(e) => setFilterTheatre(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">All Theatres</option>
                    {theatres.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <select
                    value={filterRegion}
                    onChange={(e) => setFilterRegion(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">All Regions</option>
                    {regions.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <select
                    value={filterCountry}
                    onChange={(e) => setFilterCountry(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">All Countries</option>
                    {countries.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <select
                    value={filterIlt}
                    onChange={(e) => setFilterIlt(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">All Trainings</option>
                    {iltTitles.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <select
                    value={filterCert}
                    onChange={(e) => setFilterCert(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">All Certifications</option>
                    {certTitles.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Results Table */}
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
                      <th className="px-4 py-3 text-left font-semibold">ILT Completed Date</th>
                      <th className="px-4 py-3 text-left font-semibold">ILT Active</th>
                      <th className="px-4 py-3 text-left font-semibold">Certification Not Obtained</th>
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
                        <td className="px-4 py-3">{new Date(row.iltCompletedDate).toLocaleDateString()}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${row.iltActive ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
                            {row.iltActive ? "Yes" : "No"}
                          </span>
                        </td>
                        <td className="px-4 py-3">{row.certificationFullTitle}</td>
                      </tr>
                    ))}
                    {filteredData.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
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
