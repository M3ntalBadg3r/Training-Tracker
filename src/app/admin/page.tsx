"use client";

import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import { Globe, BookOpen, HardDrive, Upload, ChevronRight, Users, Sparkles, RefreshCw, CalendarClock } from "lucide-react";

export default function AdminPage() {
  return (
    <div>
      <PageHeader title="Admin" helpSlug="admin" />

      {/* Sub-page links */}
      <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/admin/import"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <Upload size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Import</h3>
              <p className="text-sm text-gray-500">Import student training data from CSV or Excel</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/admin/region-data"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <Globe size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Region Data</h3>
              <p className="text-sm text-gray-500">Manage countries and regions</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/admin/training-data"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <BookOpen size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Training Data</h3>
              <p className="text-sm text-gray-500">Manage training programs</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/admin/users"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <Users size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">User Management</h3>
              <p className="text-sm text-gray-500">Manage user accounts, roles, and MFA</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/admin/backup"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <HardDrive size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Backup &amp; Restore</h3>
              <p className="text-sm text-gray-500">Export or import system data</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/admin/cleanup"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <Sparkles size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Data Clean-Up</h3>
              <p className="text-sm text-gray-500">Scan and fix data quality issues</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/admin/updates"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <RefreshCw size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Updates</h3>
              <p className="text-sm text-gray-500">Check for and apply application updates</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/admin/scheduled-exports"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <CalendarClock size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Scheduled Exports</h3>
              <p className="text-sm text-gray-500">Automate report delivery on a schedule</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
      </section>

    </div>
  );
}
