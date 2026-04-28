"use client";

import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import { BarChart2, Briefcase, Clock, CalendarDays, AlertCircle, ChevronRight } from "lucide-react";

export default function ReportsPage() {
  return (
    <div>
      <PageHeader title="Reports" helpSlug="reports" />

      <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/reports/by-product-type"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <BarChart2 size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">By Product Type</h3>
              <p className="text-sm text-gray-500">All training records broken down by product type</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/reports/by-function"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <Briefcase size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">By Function</h3>
              <p className="text-sm text-gray-500">All training records broken down by function (Sales, Pre-Sales, Deployments)</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/reports/expiring-soon"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <Clock size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Expiring Soon</h3>
              <p className="text-sm text-gray-500">Training records expiring within the next 1, 3, or 6 months</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/reports/last-12-months"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <CalendarDays size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Last 12 Months</h3>
              <p className="text-sm text-gray-500">Training records completed in the last 12 months</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/reports/trained-not-certified"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <AlertCircle size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Trained But Not Certified</h3>
              <p className="text-sm text-gray-500">Students who completed an ILT but haven&apos;t obtained the associated Certification</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
      </section>
    </div>
  );
}
