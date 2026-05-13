"use client";

import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import {
  BarChart2,
  Briefcase,
  Clock,
  CalendarDays,
  AlertCircle,
  ChevronRight,
  Target,
  BookOpen,
  TrendingUp,
  RefreshCw,
} from "lucide-react";

const TILES = [
  {
    href: "/reports/by-product-type",
    title: "By Product Type",
    description: "All training records broken down by product type",
    Icon: BarChart2,
  },
  {
    href: "/reports/by-function",
    title: "By Function",
    description: "All training records broken down by function (Sales, Pre-Sales, Deployments)",
    Icon: Briefcase,
  },
  {
    href: "/reports/expiring-soon",
    title: "Expiring Soon",
    description: "Training records expiring within the next 1, 3, 6, or 12 months",
    Icon: Clock,
  },
  {
    href: "/reports/last-12-months",
    title: "Achievement Over Time",
    description: "Training records over a chosen time range (1/3/6/12 months or custom), with prior-period comparison",
    Icon: CalendarDays,
  },
  {
    href: "/reports/trained-not-certified",
    title: "Trained But Not Certified",
    description: "Students who completed an ILT but haven't obtained the associated Certification",
    Icon: AlertCircle,
  },
  {
    href: "/reports/coverage",
    title: "Coverage / Compliance",
    description: "Active training holders by theatre, region, or country, as a share of population",
    Icon: Target,
  },
  {
    href: "/reports/catalogue-health",
    title: "Training Catalogue Health",
    description: "Per-training uptake, completions, and 90-day expiry pressure — find dead and at-risk titles",
    Icon: BookOpen,
  },
  {
    href: "/reports/program-compliance-trend",
    title: "Program Compliance Trend",
    description: "Monthly snapshots of APS and Global Diamond compliance over the last 12 months",
    Icon: TrendingUp,
  },
  {
    href: "/reports/renewal-forecast",
    title: "Renewal Forecast",
    description: "Projected renewals and lapses over the next 6 and 12 months from historical renewal rates",
    Icon: RefreshCw,
  },
];

export default function ReportsPage() {
  return (
    <div>
      <PageHeader title="Reports" helpSlug="reports" />

      <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map(({ href, title, description, Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
          >
            <div className="flex items-center gap-3">
              <Icon size={20} className="text-blue-600" />
              <div>
                <h3 className="font-semibold">{title}</h3>
                <p className="text-sm text-gray-500">{description}</p>
              </div>
            </div>
            <ChevronRight size={20} className="text-gray-400" />
          </Link>
        ))}
      </section>
    </div>
  );
}
