"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import { Package, ChevronRight } from "lucide-react";

interface OfferingInfo {
  name: string;
  description: string | null;
  link: string | null;
  specialisationCount: number;
}

export default function OfferingsPage() {
  const [offerings, setOfferings] = useState<OfferingInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/offerings")
      .then((r) => r.json())
      .then((d) => setOfferings(d.offerings || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <PageHeader title="Offerings" helpSlug="offerings" />

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : offerings.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          No offerings configured yet. Add them in{" "}
          <Link href="/admin/offerings" className="text-blue-600 hover:underline">Admin &rsaquo; Offerings</Link>.
        </div>
      ) : (
        <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {offerings.map((o) => (
            <Link
              key={o.name}
              href={`/offerings/${encodeURIComponent(o.name)}`}
              className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Package size={20} className="text-blue-600 shrink-0" />
                <div className="min-w-0">
                  <h3 className="font-semibold truncate">{o.name}</h3>
                  <p className="text-sm text-gray-500 truncate">
                    {o.description || `${o.specialisationCount} specialisation${o.specialisationCount === 1 ? "" : "s"}`}
                  </p>
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
