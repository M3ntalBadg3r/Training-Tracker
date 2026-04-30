"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import { Search, Download, ArrowLeft } from "lucide-react";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";

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
      <button onClick={() => setShow((prev) => !prev)} className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">
        <Download size={16} /> Export
      </button>
      {show && (
        <div className="absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[140px]">
          <button onClick={() => { exportToCsv(data, columns as never, filename); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-lg">Export as CSV</button>
          <button onClick={() => { exportToExcel(data, columns as never, filename); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100">Export as Excel</button>
          <button onClick={() => { exportToPdf(data, columns as never, filename); setShow(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-lg">Export as PDF</button>
        </div>
      )}
    </div>
  );
}

export default function Last12MonthsPage() {
  const router = useRouter();
  const [trainingRecords, setTrainingRecords] = useState<TrainingRecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [achSearch, setAchSearch] = useState("");
  const [achType, setAchType] = useState("");
  const [achTheatre, setAchTheatre] = useState("");

  const now = useMemo(() => new Date(), []);
  const companyScope = useCompanyScope();

  useEffect(() => {
    if (companyScope.loading) return;
    setLoading(true);
    fetch(withCompany("/api/reports/training-records", companyScope.selected))
      .then((r) => r.json())
      .then((data) => { setTrainingRecords(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [companyScope.loading, companyScope.selected]);

  const trTypes = useMemo(() => [...new Set(trainingRecords.map((r) => r.trainingType))].filter(Boolean).sort(), [trainingRecords]);
  const trTheatres = useMemo(() => [...new Set(trainingRecords.map((r) => r.theatre))].filter(Boolean).sort(), [trainingRecords]);

  const filtered = useMemo(() => {
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

  const exportColumns = [
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

  const exportRows = filtered.map((r) => ({
    ...r,
    completedDate: new Date(r.completedDate).toLocaleDateString(),
    expiryDate: new Date(r.expiryDate).toLocaleDateString(),
    active: r.active ? "Yes" : "No",
  }));

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading report...</div></div>;
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Reports
        </Link>
      </div>
      <PageHeader title="Achieved Over Last 12 Months" helpSlug="reports" />

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <p className="text-sm text-gray-500">Training records completed in the last 12 months</p>
          <span className="text-sm font-medium text-gray-500">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" placeholder="Search by name or email..." value={achSearch} onChange={(e) => setAchSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
              </div>
              <ExportMenu data={exportRows as never} columns={exportColumns} filename="achieved-last-12-months" />
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
                {filtered.map((row, idx) => (
                  <tr key={`${row.email}-${row.trainingTitle}-${idx}`} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3">{row.fullName}</td>
                    <td className="px-4 py-3">{row.email}</td>
                    <td className="px-4 py-3">{row.theatre || "-"}</td>
                    <td className="px-4 py-3">{row.country || "-"}</td>
                    <td className="px-4 py-3">{row.trainingTitle}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${row.trainingType === "Certification" ? "bg-blue-100 text-blue-800" : row.trainingType === "Accreditation" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
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
                      <button onClick={() => router.push(`/students/${encodeURIComponent(row.email)}`)} className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors">View</button>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={12} className="px-4 py-8 text-center text-gray-500">No records found from the last 12 months.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {filtered.length > 0 && (
            <div className="mt-3 text-sm text-gray-500">Showing {filtered.length} records from the last 12 months</div>
          )}
        </div>
      </div>
    </div>
  );
}
