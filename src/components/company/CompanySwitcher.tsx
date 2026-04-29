"use client";

import { Building2 } from "lucide-react";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";
import { useAuth } from "@/components/auth/AuthProvider";

export default function CompanySwitcher() {
  const { user } = useAuth();
  const { companies, selected, setSelected, canViewAll, loading } = useCompanyScope();

  if (!user) return null;
  if (loading) return null;
  // Hide the switcher entirely when there's nothing meaningful to pick from.
  if (companies.length === 0 && !canViewAll) {
    return (
      <div className="flex items-center gap-2 text-xs text-amber-600">
        <Building2 size={14} />
        No company access
      </div>
    );
  }
  if (companies.length <= 1 && !canViewAll) return null;

  return (
    <div className="flex items-center gap-2">
      <Building2 size={16} className="text-gray-500" />
      <select
        value={selected === "all" ? "all" : String(selected)}
        onChange={(e) => setSelected(e.target.value === "all" ? "all" : Number(e.target.value))}
        className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
        title="Filter data by company"
      >
        {canViewAll && <option value="all">All companies</option>}
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
