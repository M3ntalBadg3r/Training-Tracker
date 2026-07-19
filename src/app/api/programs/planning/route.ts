import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import prisma from "@/lib/prisma";
import { computeCompliancePlan, type PlanTarget } from "@/lib/compliance-plan";

/**
 * Compliance Planning endpoint — the action layer over program compliance.
 *
 * Two modes:
 *  - `?options=true`  → per-program selector metadata (name, isTiered, levels,
 *    tier names, specialisation names) so the page can build the target selector
 *    without one detail fetch per program.
 *  - default (plan)   → a gap-closing plan for the selected `targets` + scope:
 *    aggregate roadmap, greedy-allocated candidate drill-down, and renewal-at-risk
 *    overlay. Mirrors the report skeleton (auth → company scope → fail-closed empty
 *    response → cachedReport → Cache-Control), and is flushed by the same
 *    `invalidateReportCache()` that program/training/cert writes already call.
 *
 * `targets` is a URL-encoded JSON array:
 *   [{ program, mode: "tier"|"specialisations"|"all", tier?, specialisations?[] }]
 * so mixed selections ("Gold in Program A + all specs in Program B") are one request.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));

  const p = request.nextUrl.searchParams;

  // ── Selector-metadata mode ──
  if (p.get("options") === "true") {
    const options = await cachedReport("compliance-planning-options", () => buildPlanningOptions());
    return NextResponse.json({ programs: options }, { headers: { "Cache-Control": "private, max-age=30" } });
  }

  // Fail closed on empty company scope (before the cache), like the reports.
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({
      scopeLabel: "",
      renewalWindowMonths: 0,
      targets: [],
      candidates: [],
      renewals: [],
      totals: { peopleMoves: 0, easyWins: 0, lapsed: 0, legacy: 0, netNew: 0, renewalsAtRisk: 0 },
    });
  }

  // Parse targets.
  let targets: PlanTarget[] = [];
  const rawTargets = p.get("targets");
  if (rawTargets) {
    try {
      const parsed = JSON.parse(rawTargets);
      if (Array.isArray(parsed)) {
        targets = parsed
          .filter((t) => t && typeof t.program === "string")
          .map((t) => ({
            program: String(t.program),
            mode: t.mode === "tier" || t.mode === "specialisations" ? t.mode : "all",
            tier: typeof t.tier === "string" ? t.tier : undefined,
            specialisations: Array.isArray(t.specialisations)
              ? t.specialisations.map((s: unknown) => String(s))
              : undefined,
          }));
      }
    } catch {
      return NextResponse.json({ error: "Invalid targets" }, { status: 400 });
    }
  }

  const level = p.get("level") || "global";
  const country = p.get("country") || "";
  const region = p.get("region") || "";
  const theatre = p.get("theatre") || "";
  const rawWindow = parseInt(p.get("renewalWindowMonths") || "3", 10);
  const renewalWindowMonths = [0, 1, 3, 6, 12].includes(rawWindow) ? rawWindow : 3;

  if (targets.length === 0) {
    return NextResponse.json({
      scopeLabel: "",
      renewalWindowMonths,
      targets: [],
      candidates: [],
      renewals: [],
      totals: { peopleMoves: 0, easyWins: 0, lapsed: 0, legacy: 0, netNew: 0, renewalsAtRisk: 0 },
    });
  }

  const key = [
    "compliance-planning",
    scopeKey(companyFilter),
    encodeURIComponent(rawTargets ?? ""),
    level,
    country,
    region,
    theatre,
    renewalWindowMonths,
  ].join("|");

  const result = await cachedReport(key, () =>
    computeCompliancePlan({ targets, level, country, region, theatre, companyIds: companyFilter, renewalWindowMonths }),
  );

  return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
}

interface PlanningOption {
  name: string;
  isTiered: boolean;
  levels: string[];
  tiers: string[];
  specialisations: string[];
}

/** Per-program metadata for the target selector (company-agnostic, like /api/programs). */
async function buildPlanningOptions(): Promise<PlanningOption[]> {
  const [programs, programData, tiers] = await Promise.all([
    prisma.program.findMany({ select: { name: true, isTiered: true } }),
    prisma.programData.findMany({
      select: { programName: true, level: true, specialisation: { select: { name: true } } },
    }),
    prisma.programTier.findMany({ orderBy: { sortOrder: "asc" }, select: { programName: true, name: true } }),
  ]);

  const isTieredByName = new Map(programs.map((p) => [p.name, p.isTiered]));
  const names = new Set<string>([
    ...programs.filter((p) => p.isTiered).map((p) => p.name),
    ...programData.map((d) => d.programName),
  ]);

  const result: PlanningOption[] = [];
  for (const name of [...names].sort()) {
    const rows = programData.filter((d) => d.programName === name);
    const levels = [...new Set(rows.map((d) => d.level))];
    const specialisations = [
      ...new Set(rows.map((d) => d.specialisation?.name).filter((n): n is string => !!n)),
    ].sort();
    const tierNames = tiers.filter((t) => t.programName === name).map((t) => t.name);
    result.push({
      name,
      isTiered: isTieredByName.get(name) === true,
      levels,
      tiers: tierNames,
      specialisations,
    });
  }
  return result;
}
