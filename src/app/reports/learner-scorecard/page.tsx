"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import KpiStrip from "@/components/ui/KpiStrip";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";
import { exportToCsv, exportToExcel, exportToPdf } from "@/lib/export";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import { ArrowLeft, Download, Users, Award, AlertTriangle, Clock } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface TrainingRecordRow {
  fullName: string;
  email: string;
  theatre: string | null;
  region: string;
  country: string;
  trainingTitle: string;
  trainingType: string;
  productType: string;
  function: string;
  completedDate: string;
  expiryDate: string;
  active: boolean;
}

interface StudentRow {
  email: string;
  fullName: string;
  theatre: string | null;
  country: string | null;
  region: string | null;
}

interface GapRow {
  email: string;
}

interface LearnerRow {
  email: string;
  fullName: string;
  theatre: string;
  region: string;
  country: string;
  cert: number;
  accred: number;
  ilt: number;
  olx: number;
  total: number;
  expiring: number;
  lapsed: number;
  gaps: number;
  lastDate: string; // ISO, or "" for learners with no completions
}

type SortKey =
  | "fullName"
  | "cert"
  | "accred"
  | "ilt"
  | "olx"
  | "total"
  | "expiring"
  | "lapsed"
  | "gaps"
  | "lastDate";

const WINDOW_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Expiring in 1 month" },
  { value: 3, label: "Expiring in 3 months" },
  { value: 6, label: "Expiring in 6 months" },
];

function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function ExportMenu({ data, columns, filename }: { data: Record<string, unknown>[]; columns: { key: string; header: string }[]; filename: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setShow((p) => !p)} className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">
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

export default function LearnerScorecardPage() {
  const chart = useChartTheme();
  const companyScope = useCompanyScope();
  const { formatDate } = useDateFormat();

  const [records, setRecords] = useState<TrainingRecordRow[]>([]);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [gaps, setGaps] = useState<GapRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [filterTheatre, setFilterTheatre] = useState("");
  const [filterRegion, setFilterRegion] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [windowMonths, setWindowMonths] = useState(6);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const now = useMemo(() => new Date(), []);

  useEffect(() => {
    if (companyScope.loading) return;
    setLoading(true);
    Promise.all([
      fetch(withCompany("/api/reports/training-records", companyScope.selected)).then((r) => r.json()),
      fetch(withCompany("/api/students", companyScope.selected)).then((r) => r.json()),
      fetch(withCompany("/api/reports/trained-not-certified", companyScope.selected)).then((r) => r.json()),
    ])
      .then(([recs, studs, gapRows]) => {
        setRecords(Array.isArray(recs) ? recs : []);
        setStudents(Array.isArray(studs) ? studs : []);
        setGaps(Array.isArray(gapRows) ? gapRows : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [companyScope.loading, companyScope.selected]);

  const windowCutoff = useMemo(() => addMonths(now, windowMonths), [now, windowMonths]);

  // Per-learner aggregation. Seed from the full roster so learners with zero
  // completions still appear (valuable for the management view), then fold in
  // training records and certification-gap counts.
  const learners: LearnerRow[] = useMemo(() => {
    const map = new Map<string, LearnerRow>();
    const ensure = (email: string, seed: { fullName: string; theatre: string; region: string; country: string }): LearnerRow => {
      let row = map.get(email);
      if (!row) {
        row = {
          email,
          fullName: seed.fullName,
          theatre: seed.theatre,
          region: seed.region,
          country: seed.country,
          cert: 0, accred: 0, ilt: 0, olx: 0, total: 0,
          expiring: 0, lapsed: 0, gaps: 0, lastDate: "",
        };
        map.set(email, row);
      }
      return row;
    };

    for (const s of students) {
      ensure(s.email, {
        fullName: s.fullName,
        theatre: s.theatre ?? "",
        region: s.region ?? "",
        country: s.country ?? "",
      });
    }

    for (const r of records) {
      const row = ensure(r.email, {
        fullName: r.fullName,
        theatre: r.theatre ?? "",
        region: r.region ?? "",
        country: r.country ?? "",
      });

      // Counts honour the active/expired toggle: active-only by default.
      if (includeExpired || r.active) {
        if (r.trainingType === "Certification") row.cert += 1;
        else if (r.trainingType === "Accreditation") row.accred += 1;
        else if (r.trainingType === "Instructor-Led Training") row.ilt += 1;
        else if (r.trainingType === "OLX") row.olx += 1;
      }

      // Lapsed = expired achievements (independent of the toggle).
      if (!r.active) row.lapsed += 1;

      // Expiring = active certs/accreditations renewing within the window.
      if (r.active && (r.trainingType === "Certification" || r.trainingType === "Accreditation") && r.expiryDate) {
        const exp = new Date(r.expiryDate);
        if (exp >= now && exp <= windowCutoff) row.expiring += 1;
      }

      // Most recent completion across all of the learner's records.
      if (r.completedDate && r.completedDate > row.lastDate) row.lastDate = r.completedDate;
    }

    // Certification gaps: one trained-not-certified row per (training, learner).
    for (const g of gaps) {
      const row = map.get(g.email);
      if (row) row.gaps += 1;
    }

    for (const row of map.values()) {
      row.total = row.cert + row.accred + row.ilt + row.olx;
    }
    return Array.from(map.values());
  }, [students, records, gaps, includeExpired, now, windowCutoff]);

  const theatres = useMemo(() => [...new Set(learners.map((l) => l.theatre))].filter(Boolean).sort(), [learners]);
  const regions = useMemo(() => [...new Set(learners.map((l) => l.region))].filter(Boolean).sort(), [learners]);
  const countries = useMemo(() => [...new Set(learners.map((l) => l.country))].filter(Boolean).sort(), [learners]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return learners.filter((l) => {
      if (filterTheatre && l.theatre !== filterTheatre) return false;
      if (filterRegion && l.region !== filterRegion) return false;
      if (filterCountry && l.country !== filterCountry) return false;
      if (q && !l.fullName.toLowerCase().includes(q) && !l.email.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [learners, search, filterTheatre, filterRegion, filterCountry]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (sortKey === "fullName") {
        return sortDir === "asc" ? a.fullName.localeCompare(b.fullName) : b.fullName.localeCompare(a.fullName);
      }
      if (sortKey === "lastDate") {
        // Empty (no completions) sorts last regardless of direction.
        if (!a.lastDate && !b.lastDate) return 0;
        if (!a.lastDate) return 1;
        if (!b.lastDate) return -1;
        return sortDir === "asc" ? a.lastDate.localeCompare(b.lastDate) : b.lastDate.localeCompare(a.lastDate);
      }
      const av = a[sortKey] as number;
      const bv = b[sortKey] as number;
      if (av !== bv) return sortDir === "asc" ? av - bv : bv - av;
      return a.fullName.localeCompare(b.fullName);
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const kpis = useMemo(() => {
    let achievements = 0, withGaps = 0, withExpiring = 0, zero = 0;
    for (const l of filtered) {
      achievements += l.total;
      if (l.gaps > 0) withGaps += 1;
      if (l.expiring > 0) withExpiring += 1;
      if (l.total === 0) zero += 1;
    }
    return { learners: filtered.length, achievements, withGaps, withExpiring, zero };
  }, [filtered]);

  // Leaderboard: top achievers by total achievements (recognition view).
  const leaderboard = useMemo(() => {
    return [...filtered]
      .filter((l) => l.total > 0)
      .sort((a, b) => b.total - a.total || a.fullName.localeCompare(b.fullName))
      .slice(0, 15)
      .map((l) => ({ name: l.fullName, total: l.total }));
  }, [filtered]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "fullName" ? "asc" : "desc");
    }
  }

  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  const numHeader = (key: SortKey, label: string) => (
    <th className="px-4 py-3 text-right font-semibold cursor-pointer select-none whitespace-nowrap" onClick={() => toggleSort(key)}>
      {label}{sortIndicator(key)}
    </th>
  );

  const exportColumns = [
    { key: "fullName", header: "Name" },
    { key: "email", header: "Email" },
    { key: "theatre", header: "Theatre" },
    { key: "region", header: "Region" },
    { key: "country", header: "Country" },
    { key: "cert", header: "Certifications" },
    { key: "accred", header: "Accreditations" },
    { key: "ilt", header: "ILTs" },
    { key: "olx", header: "OLX" },
    { key: "total", header: "Total" },
    { key: "expiring", header: `Expiring ${windowMonths}mo` },
    { key: "lapsed", header: "Lapsed" },
    { key: "gaps", header: "Cert Gaps" },
    { key: "lastDate", header: "Last Achievement" },
  ];
  const exportRows = sorted.map((l) => ({ ...l, lastDate: l.lastDate ? formatDate(l.lastDate) : "" }));

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
      <PageHeader title="Learner Achievement Scorecard" helpSlug="reports-learner-scorecard" />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or email…"
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white min-w-[200px]"
        />
        <select value={filterTheatre} onChange={(e) => setFilterTheatre(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
          <option value="">All Theatres</option>
          {theatres.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={filterRegion} onChange={(e) => setFilterRegion(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
          <option value="">All Regions</option>
          {regions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
          <option value="">All Countries</option>
          {countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={windowMonths} onChange={(e) => setWindowMonths(Number(e.target.value))} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
          {WINDOW_OPTIONS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={includeExpired} onChange={(e) => setIncludeExpired(e.target.checked)} className="rounded border-gray-300" />
          Include expired in counts
        </label>
      </div>

      <KpiStrip
        cards={[
          { label: "Learners", value: kpis.learners, icon: Users, tone: "blue", hint: `${kpis.zero.toLocaleString()} with no achievements` },
          { label: includeExpired ? "Total Achievements" : "Active Achievements", value: kpis.achievements, icon: Award, tone: "emerald" },
          { label: "Learners with Cert Gaps", value: kpis.withGaps, icon: AlertTriangle, tone: "amber" },
          { label: `Renewing in ${windowMonths}mo`, value: kpis.withExpiring, icon: Clock, tone: "red" },
        ]}
      />

      <section className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 className="text-base font-semibold text-gray-900 mb-4">
          Top Achievers — {includeExpired ? "total" : "active"} achievements
        </h3>
        {leaderboard.length > 0 ? (
          <ResponsiveContainer width="100%" height={340}>
            <BarChart data={leaderboard} margin={{ bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={70} interval={0} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Bar dataKey="total" name="Achievements" fill={chart.series(0)} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-gray-500 py-8 text-center">No achievements for the selected filters.</p>
        )}
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">
            One row per learner. Counts are {includeExpired ? "all completions" : "active only"}; renewing and gap counts always look forward from today.
          </p>
          <ExportMenu data={exportRows as never} columns={exportColumns} filename="learner-scorecard" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="px-4 py-3 text-left font-semibold cursor-pointer select-none" onClick={() => toggleSort("fullName")}>Name{sortIndicator("fullName")}</th>
                <th className="px-4 py-3 text-left font-semibold">Theatre</th>
                <th className="px-4 py-3 text-left font-semibold">Country</th>
                {numHeader("cert", "Certs")}
                {numHeader("accred", "Accreds")}
                {numHeader("ilt", "ILTs")}
                {numHeader("olx", "OLX")}
                {numHeader("total", "Total")}
                {numHeader("expiring", "Renewing")}
                {numHeader("lapsed", "Lapsed")}
                {numHeader("gaps", "Gaps")}
                {numHeader("lastDate", "Last Achievement")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((l) => (
                <tr key={l.email} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link href={`/students/${encodeURIComponent(l.email)}`} className="font-medium text-blue-600 hover:underline">{l.fullName}</Link>
                    <div className="text-xs text-gray-400">{l.email}</div>
                  </td>
                  <td className="px-4 py-3">{l.theatre || "—"}</td>
                  <td className="px-4 py-3">{l.country || "—"}</td>
                  <td className="px-4 py-3 text-right">{l.cert.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{l.accred.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{l.ilt.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{l.olx.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-semibold">{l.total.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{l.expiring > 0 ? <span className="text-amber-600 font-medium">{l.expiring}</span> : "—"}</td>
                  <td className="px-4 py-3 text-right">{l.lapsed > 0 ? <span className="text-gray-500">{l.lapsed}</span> : "—"}</td>
                  <td className="px-4 py-3 text-right">{l.gaps > 0 ? <span className="text-red-600 font-medium">{l.gaps}</span> : "—"}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{l.lastDate ? formatDate(l.lastDate) : "—"}</td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={12} className="px-4 py-8 text-center text-gray-500">No learners for the selected filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
