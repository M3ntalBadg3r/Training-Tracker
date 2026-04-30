"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import CredentialHealthBanner from "@/components/admin/CredentialHealthBanner";
import {
  Users,
  Award,
  ShieldCheck,
  GraduationCap,
  Globe,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";
import { useChartTheme, tooltipStyle } from "@/lib/chart-theme";

interface DashboardData {
  theatres: string[];
  metrics: {
    totalStudents: number;
    certifications: number;
    accreditations: number;
    instructorLedTraining: number;
  };
  byProductType: {
    name: string;
    Certification: number;
    Accreditation: number;
    "Instructor-Led Training": number;
  }[];
  byFunction: {
    name: string;
    Certification: number;
    Accreditation: number;
    "Instructor-Led Training": number;
  }[];
  expiring: {
    name: string;
    Certification: number;
    Accreditation: number;
    "Instructor-Led Training": number;
  }[];
  monthlyAchieved: {
    month: string;
    Certification: number;
    Accreditation: number;
    "Instructor-Led Training": number;
  }[];
}

export default function DashboardPage() {
  const router = useRouter();
  const chart = useChartTheme();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTheatre, setSelectedTheatre] = useState("Global");
  const [theatreLoading, setTheatreLoading] = useState(false);
  const cache = useRef<Record<string, DashboardData>>({});

  const fetchDashboard = useCallback(async (theatre: string) => {
    const params = theatre !== "Global" ? `?theatre=${encodeURIComponent(theatre)}` : "";
    const res = await fetch(`/api/dashboard${params}`);
    if (!res.ok) throw new Error("Failed to fetch");
    const d: DashboardData = await res.json();
    cache.current[theatre] = d;
    return d;
  }, []);

  // Initial load
  useEffect(() => {
    fetchDashboard("Global")
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [fetchDashboard]);

  // Theatre change
  const handleTheatreChange = async (theatre: string) => {
    setSelectedTheatre(theatre);

    if (cache.current[theatre]) {
      setData(cache.current[theatre]);
      return;
    }

    setTheatreLoading(true);
    try {
      const d = await fetchDashboard(theatre);
      setData(d);
    } catch {
      // Keep current data on error
    }
    setTheatreLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading dashboard...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Failed to load dashboard data.</div>
      </div>
    );
  }

  const { metrics } = data;

  const metricCards = [
    {
      label: "Total Students",
      value: metrics.totalStudents,
      icon: Users,
      color: "bg-blue-50 text-blue-700",
      iconColor: "text-blue-500",
    },
    {
      label: "Certifications Earned",
      value: metrics.certifications,
      icon: Award,
      color: "bg-indigo-50 text-indigo-700",
      iconColor: "text-indigo-500",
    },
    {
      label: "Accreditations Earned",
      value: metrics.accreditations,
      icon: ShieldCheck,
      color: "bg-emerald-50 text-emerald-700",
      iconColor: "text-emerald-500",
    },
    {
      label: "Instructor-Led Trainings",
      value: metrics.instructorLedTraining,
      icon: GraduationCap,
      color: "bg-amber-50 text-amber-700",
      iconColor: "text-amber-500",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        helpSlug="dashboard"
        rightContent={
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-gray-400" />
            <select
              value={selectedTheatre}
              onChange={(e) => handleTheatreChange(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="Global">Global</option>
              {data.theatres.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {theatreLoading && (
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            )}
          </div>
        }
      />

      <CredentialHealthBanner />

      {/* Metric Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {metricCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className="bg-white rounded-lg border border-gray-200 p-5 flex items-center gap-4"
            >
              <div className={`p-3 rounded-lg ${card.color}`}>
                <Icon size={24} className={card.iconColor} />
              </div>
              <div>
                <div className="text-2xl font-bold text-gray-900">{card.value.toLocaleString()}</div>
                <div className="text-sm text-gray-500">{card.label}</div>
              </div>
            </div>
          );
        })}
      </section>

      {/* Charts Row 1: By Product Type & By Function */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div
          onClick={() => router.push("/reports/by-product-type")}
          className="bg-white rounded-lg border border-gray-200 p-5 cursor-pointer hover:border-blue-300 hover:shadow-md transition-all"
          title="Click to view full report"
        >
          <h3 className="text-base font-semibold text-gray-900 mb-4">By Product Type</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.byProductType}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Bar dataKey="Certification" fill={chart.typeColor("Certification")} />
              <Bar dataKey="Accreditation" fill={chart.typeColor("Accreditation")} />
              <Bar dataKey="Instructor-Led Training" fill={chart.typeColor("Instructor-Led Training")} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div
          onClick={() => router.push("/reports/by-function")}
          className="bg-white rounded-lg border border-gray-200 p-5 cursor-pointer hover:border-blue-300 hover:shadow-md transition-all"
          title="Click to view full report"
        >
          <h3 className="text-base font-semibold text-gray-900 mb-4">By Function</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.byFunction}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Bar dataKey="Certification" fill={chart.typeColor("Certification")} />
              <Bar dataKey="Accreditation" fill={chart.typeColor("Accreditation")} />
              <Bar dataKey="Instructor-Led Training" fill={chart.typeColor("Instructor-Led Training")} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Charts Row 2: Expiring & Monthly Achieved */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div
          onClick={() => router.push("/reports/expiring-soon")}
          className="bg-white rounded-lg border border-gray-200 p-5 cursor-pointer hover:border-blue-300 hover:shadow-md transition-all"
          title="Click to view full report"
        >
          <h3 className="text-base font-semibold text-gray-900 mb-4">Expiring Soon</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.expiring}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Bar dataKey="Certification" fill={chart.typeColor("Certification")} />
              <Bar dataKey="Accreditation" fill={chart.typeColor("Accreditation")} />
              <Bar dataKey="Instructor-Led Training" fill={chart.typeColor("Instructor-Led Training")} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div
          onClick={() => router.push("/reports/last-12-months")}
          className="bg-white rounded-lg border border-gray-200 p-5 cursor-pointer hover:border-blue-300 hover:shadow-md transition-all"
          title="Click to view full report"
        >
          <h3 className="text-base font-semibold text-gray-900 mb-4">Achieved Over Last 12 Months</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.monthlyAchieved}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: chart.axis }} stroke={chart.axis} angle={-35} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: chart.axis }} stroke={chart.axis} />
              <Tooltip contentStyle={tooltipStyle(chart)} />
              <Legend />
              <Line type="monotone" dataKey="Certification" stroke={chart.typeColor("Certification")} strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="Accreditation" stroke={chart.typeColor("Accreditation")} strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="Instructor-Led Training" stroke={chart.typeColor("Instructor-Led Training")} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
