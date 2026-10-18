"use client";

import { Building2 } from "lucide-react";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";
import { useAuth } from "@/components/auth/AuthProvider";
import CompanyPicker from "@/components/company/CompanyPicker";

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
      <CompanyPicker
        options={companies}
        value={selected}
        onChange={(next) => {
          if (next !== null) setSelected(next);
        }}
        allOption={canViewAll}
        aria-label="Filter data by company"
        title="Filter data by company"
        placeholder="Search companies…"
        className="w-44 sm:w-64"
      />
    </div>
  );
}
