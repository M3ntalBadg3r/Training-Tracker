"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import { useCompanyScope, withCompany } from "@/components/company/CompanyScopeProvider";
import { Package, ChevronRight } from "lucide-react";

interface OfferingInfo {
  name: string;
  companyId: number;
  companyName: string | null;
  description: string | null;
  link: string | null;
  specialisationCount: number;
  requirementCount: number;
}

export default function OfferingsPage() {
  const scope = useCompanyScope();
  const [offerings, setOfferings] = useState<OfferingInfo[]>([]);
  const [loading, setLoading] = useState(true);
  // Same rule as the admin index: name the company only when the view spans more
  // than one, otherwise every card would repeat the selected company.
  const showCompany = scope.selected === "all";

  useEffect(() => {
    if (scope.loading) return;
    let cancelled = false;
    fetch(withCompany("/api/offerings", scope.selected))
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setOfferings(d.offerings || []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope.loading, scope.selected]);

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
        // Card layout mirrors /admin/offerings so the two indexes match.
        <section className="mb-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {offerings.map((o) => {
            const companyName = o.companyName ?? scope.companies.find((c) => c.id === o.companyId)?.name ?? null;
            return (
              <Link
                key={`${o.companyId}:${o.name}`}
                href={`/offerings/${encodeURIComponent(o.name)}?companyId=${o.companyId}`}
                className="block border border-gray-200 rounded-xl p-4 bg-white hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Package size={18} className="text-blue-600 shrink-0" />
                      <h3 className="font-semibold text-gray-900 truncate">{o.name}</h3>
                    </div>
                    {showCompany && companyName && (
                      <span className="mt-1 inline-block px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded">{companyName}</span>
                    )}
                    {o.description && <p className="mt-1 text-sm text-gray-500 line-clamp-2">{o.description}</p>}
                    <p className="mt-2 text-xs text-gray-400">
                      {o.specialisationCount} specialisation{o.specialisationCount === 1 ? "" : "s"} · {o.requirementCount} requirement{o.requirementCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <ChevronRight size={20} className="text-gray-400 shrink-0 ml-2" />
                </div>
              </Link>
            );
          })}
        </section>
      )}
    </div>
  );
}
