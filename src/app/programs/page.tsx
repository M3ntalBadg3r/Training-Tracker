"use client";

import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import { Award, Gem, ChevronRight } from "lucide-react";

export default function ProgramsPage() {
  return (
    <div>
      <PageHeader title="Programs" helpSlug="programs" />

      <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/programs/aps"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <Award size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">APS</h3>
              <p className="text-sm text-gray-500">View Authorized Professional Services compliance requirements by country, region, and theatre</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/programs/global-diamond"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <Gem size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Global Diamond</h3>
              <p className="text-sm text-gray-500">View Global Diamond compliance requirements and theatre-level attainment</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
      </section>
    </div>
  );
}
