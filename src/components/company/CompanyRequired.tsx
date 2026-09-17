"use client";

import { Building2 } from "lucide-react";
import EmptyState from "@/components/ui/EmptyState";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";

/**
 * The gate for a page that can only report on one company at a time.
 *
 * Such a page used to fall back to `companies[0]` under "All companies" and
 * render a confident, fully-populated view for whichever company happened to
 * sort first — presented as if it covered them all. Asking is the honest
 * answer, and it leaves the header switcher as the single company control
 * rather than giving the page a second one that can disagree with it.
 */

/** True once the scope has loaded and the header is on "All companies". */
export function useCompanyRequired(): boolean {
  const { loading, selected } = useCompanyScope();
  // `loading` is checked FIRST, and that ordering is load-bearing. Until
  // /api/companies comes back the provider skips its allow-list reconcile, so
  // `selected` is still its `"all"` default for everyone — including the
  // single-company user the reconcile is about to pin to a concrete id. A gate
  // that ignored `loading` would flash the empty state on every mount for them.
  if (loading) return false;
  return selected === "all";
}

export default function CompanyRequired({ what }: { what: string }) {
  const { companies, canViewAll } = useCompanyScope();

  // Only someone who can genuinely pick "All companies" ever reaches this card:
  // a single-company user has `canViewAll` false, and the provider then forces
  // `selected` to their one id, so `useCompanyRequired` is false for them. That
  // is why the gate is keyed on the scope and not on the role — a
  // non-SuperAdmin holding two or more companies reaches it too.
  if (companies.length === 0) {
    // The reconcile never fires on an empty list, so `selected` stays "all" and
    // the gate is reachable — but the header has no company to offer, so "pick
    // one from the header" is advice that cannot be followed (the switcher has
    // replaced itself with a "No company access" pill). What to do instead
    // depends on who is stuck: someone with no grants needs one, whereas a
    // SuperAdmin seeing this is on an instance where no company exists yet.
    return (
      <EmptyState icon={Building2}>
        {canViewAll
          ? `No companies have been set up yet, so there is no ${what} to show.`
          : `You do not have access to any company, so this ${what} cannot be shown. Ask an administrator to grant you access.`}
      </EmptyState>
    );
  }

  return (
    <EmptyState icon={Building2}>
      Select a company from the header to view this {what}.
    </EmptyState>
  );
}
