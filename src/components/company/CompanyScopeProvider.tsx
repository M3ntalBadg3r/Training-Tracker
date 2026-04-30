"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";
import { useAuth } from "@/components/auth/AuthProvider";

export interface CompanyOption {
  id: number;
  name: string;
}

export type CompanySelection = number | "all";

interface CompanyScopeContextValue {
  companies: CompanyOption[];
  selected: CompanySelection;
  setSelected: (next: CompanySelection) => void;
  canViewAll: boolean;
  loading: boolean;
  /** Build a `?companyId=` query-string fragment for fetches; empty when "all". */
  queryString: string;
  refresh: () => Promise<void>;
}

const STORAGE_KEY = "tt.selectedCompany";

const CompanyScopeContext = createContext<CompanyScopeContextValue>({
  companies: [],
  selected: "all",
  setSelected: () => {},
  canViewAll: true,
  loading: true,
  queryString: "",
  refresh: async () => {},
});

export function useCompanyScope() {
  return useContext(CompanyScopeContext);
}

export default function CompanyScopeProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [canViewAll, setCanViewAll] = useState(true);
  const [selected, setSelectedState] = useState<CompanySelection>("all");
  const [loading, setLoading] = useState(true);

  const fetchCompanies = useCallback(async () => {
    try {
      const res = await fetch("/api/companies");
      if (!res.ok) {
        setCompanies([]);
        setCanViewAll(false);
        return;
      }
      const data = (await res.json()) as { companies: CompanyOption[]; canViewAll: boolean };
      setCompanies(data.companies);
      setCanViewAll(data.canViewAll);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    fetchCompanies();
  }, [authLoading, user, fetchCompanies]);

  // Restore persisted selection (or default to "all"), validated against the
  // current allow list once it has loaded.
  useEffect(() => {
    if (loading) return;
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    let next: CompanySelection = "all";
    if (stored && stored !== "all") {
      const id = Number(stored);
      if (!Number.isNaN(id) && companies.some((c) => c.id === id)) next = id;
    }
    if (next === "all" && !canViewAll && companies.length > 0) {
      next = companies[0].id;
    }
    setSelectedState(next);
  }, [loading, companies, canViewAll]);

  const setSelected = useCallback((next: CompanySelection) => {
    setSelectedState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next === "all" ? "all" : String(next));
    }
  }, []);

  const queryString = useMemo(() => (selected === "all" ? "" : `companyId=${selected}`), [selected]);

  const value = useMemo<CompanyScopeContextValue>(
    () => ({ companies, selected, setSelected, canViewAll, loading, queryString, refresh: fetchCompanies }),
    [companies, selected, setSelected, canViewAll, loading, queryString, fetchCompanies]
  );

  return <CompanyScopeContext.Provider value={value}>{children}</CompanyScopeContext.Provider>;
}

/**
 * Build a URL with the company-scope query parameter merged in.
 * Pass to fetch() in client components: `withCompany("/api/students", scope.selected)`.
 */
export function withCompany(path: string, selected: CompanySelection): string {
  if (selected === "all") return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}companyId=${selected}`;
}
