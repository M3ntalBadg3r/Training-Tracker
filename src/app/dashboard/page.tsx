"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import {
  Users,
  Award,
  ShieldCheck,
  GraduationCap,
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

interface DashboardData {
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

const COLORS = {
  Certification: "#3b82f6",
  Accreditation: "#10b981",
  "Instructor-Led Training": "#f59e0b",
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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
      <PageHeader title="Dashboard" helpSlug="dashboard" />

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
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">By Product Type</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.byProductType}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="Certification" fill={COLORS.Certification} />
              <Bar dataKey="Accreditation" fill={COLORS.Accreditation} />
              <Bar dataKey="Instructor-Led Training" fill={COLORS["Instructor-Led Training"]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">By Function</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.byFunction}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="Certification" fill={COLORS.Certification} />
              <Bar dataKey="Accreditation" fill={COLORS.Accreditation} />
              <Bar dataKey="Instructor-Led Training" fill={COLORS["Instructor-Led Training"]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Charts Row 2: Expiring & Monthly Achieved */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Expiring Soon</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.expiring}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="Certification" fill={COLORS.Certification} />
              <Bar dataKey="Accreditation" fill={COLORS.Accreditation} />
              <Bar dataKey="Instructor-Led Training" fill={COLORS["Instructor-Led Training"]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Achieved Over Last 12 Months</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.monthlyAchieved}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="Certification" stroke={COLORS.Certification} strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="Accreditation" stroke={COLORS.Accreditation} strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="Instructor-Led Training" stroke={COLORS["Instructor-Led Training"]} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
