"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import { ShieldCheck, ChevronRight } from "lucide-react";

interface ProgramInfo {
  name: string;
  levels: string[];
  hasMinimumPerTheatre: boolean;
  isTiered?: boolean;
}

function describe(p: ProgramInfo): string {
  if (p.isTiered) {
    return `View ${p.name} tier status by achieved specialisations`;
  }
  const parts: string[] = [];
  if (p.levels.includes("Country")) parts.push("country");
  if (p.levels.includes("Theatre")) parts.push("theatre");
  if (p.levels.includes("Global")) parts.push("global");
  const levelText = parts.length > 0 ? `by ${parts.join(", ")}` : "";
  const theatreText = p.hasMinimumPerTheatre ? " with per-theatre minimums" : "";
  return `View ${p.name} compliance requirements ${levelText}${theatreText}`.replace(/\s+/g, " ").trim();
}

export default function ProgramsPage() {
  const [programs, setPrograms] = useState<ProgramInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/programs")
      .then((r) => r.json())
      .then((d) => setPrograms(d.programs || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <PageHeader title="Programs" helpSlug="programs" />

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : programs.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          No programs configured yet. Add program requirements in{" "}
          <a href="/admin/program-data" className="text-blue-600 hover:underline">Admin &rsaquo; Program Data</a>.
        </div>
      ) : (
        <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {programs.map((p) => (
            <Link
              key={p.name}
              href={`/programs/${encodeURIComponent(p.name)}`}
              className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-center gap-3">
                <ShieldCheck size={20} className="text-blue-600 shrink-0" />
                <div>
                  <h3 className="font-semibold">{p.name}</h3>
                  <p className="text-sm text-gray-500">{describe(p)}</p>
                </div>
              </div>
              <ChevronRight size={20} className="text-gray-400 shrink-0" />
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
