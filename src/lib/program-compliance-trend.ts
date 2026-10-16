import prisma from "@/lib/prisma";
import {
  extractTitles,
  getEmailSetsByTitle,
  unionAttained,
  countriesInRegion,
  type ComplianceScope,
} from "@/lib/program-compliance";

/**
 * Program compliance trend: 12 months of history plus a 12-month forecast.
 *
 * For each (program, specialisation) pair, we compute monthly snapshots: at
 * each month-end we re-run the same union-of-primary-and-alternatives logic
 * with `asOf` set to that month-end, and report attained/required per
 * requirement plus an aggregate compliance ratio for the specialisation
 * (sum of attained, capped at sum of required).
 *
 * Historical months are genuinely point-in-time (getEmailSetsByTitle filters
 * completedDate <= asOf as well as expiryDate > asOf). Future months
 * (`projected: true`) reuse the same logic with a future asOf, so compliance
 * decays as active certifications expire — an "if nothing else is completed"
 * forecast. No new completions are assumed.
 *
 * By default we evaluate at the Global level for each program; the report can
 * be narrowed by theatre / region / country.
 *
 * **TargetCountries rows are left out, and the programs they belong to are
 * named.** This report pools every row of a program over ONE geography
 * whatever its level, while a TargetCountries row only means something over a
 * partner's own target countries inside a theatre, with a per-partner minimum.
 * Pooled here it would be misreported as a plausible number. The program's
 * other rows are kept — pooled exactly as before, which is what a program that
 * also has a By Country view (the reason this level exists) needs — and the
 * program is named in `partialPrograms`; one whose specialisation rows are ALL
 * TargetCountries rows has nothing left to show and is named in
 * `unsupportedPrograms`. The page says which, and why.
 *
 * Presentation-agnostic and auth-agnostic: it takes a plain
 * `companyIds: number[] | null` scope, so the internal (JWT) route at
 * `/api/reports/program-compliance-trend` and the public (API-key) route at
 * `/api/public/v1/reports/program-compliance-trend` are both thin wrappers over
 * this one implementation and cannot drift — the same arrangement
 * `lib/program-report.ts` already has for the per-program dashboards.
 */

/** The label with no geography selected, and the fail-closed default. */
export const TREND_DEFAULT_SCOPE_LABEL = "Global · all theatres";

export async function computeComplianceTrend(
  companyFilter: number[] | null,
  programFilter: string | null,
  countryParam: string,
  regionParam: string,
  theatreParam: string,
) {
  const geoScope: ComplianceScope = { companyIds: companyFilter };
  let scopeLabel = TREND_DEFAULT_SCOPE_LABEL;
  if (countryParam) {
    geoScope.country = countryParam;
    scopeLabel = `Country: ${countryParam}`;
  } else if (regionParam) {
    geoScope.countries = await countriesInRegion(regionParam);
    scopeLabel = `Region: ${regionParam}`;
  } else if (theatreParam) {
    geoScope.theatre = theatreParam;
    scopeLabel = `Theatre: ${theatreParam}`;
  }

  const targetRows = await prisma.programData.findMany({
    where: { level: "TargetCountries" },
    distinct: ["programName"],
    select: { programName: true },
  });
  const withTargets = new Set(targetRows.map((r) => r.programName));

  const allRows = await prisma.programData.findMany({
    where: {
      ...(programFilter ? { programName: programFilter } : {}),
      // The trend report is specialisation-scoped; tier-scoped deployment rows
      // (specialisationId null) have no specialisation to group under.
      specialisationId: { not: null },
    },
    include: {
      specialisation: true,
      trainingData: { select: { fullTitle: true } },
      alternatives: { include: { trainingData: { select: { fullTitle: true } } } },
    },
  });

  // TargetCountries rows cannot be pooled over one geography (see above).
  const rawData = allRows.filter((r) => r.level !== "TargetCountries");
  const kept = new Set(rawData.map((r) => r.programName));
  const affected = [
    ...new Set(allRows.filter((r) => r.level === "TargetCountries" && withTargets.has(r.programName)).map((r) => r.programName)),
  ].sort();
  // Shown without their TargetCountries rows / not shown at all.
  const partialPrograms = affected.filter((name) => kept.has(name));
  const unsupportedPrograms = affected.filter((name) => !kept.has(name));

  // Narrow the type: every row here has a specialisation (filtered above).
  const data = rawData.filter(
    (r): r is typeof rawData[number] & { specialisation: NonNullable<typeof r.specialisation> } =>
      r.specialisation != null
  );

  type Row = typeof data[number];

  if (data.length === 0) {
    return { snapshots: [], programs: [], specialisations: [], scopeLabel, unsupportedPrograms, partialPrograms };
  }

  // Build month boundaries: 12 months of history (incl. current) + 12 months
  // of forecast. Future months are flagged `projected` and show expiry-driven
  // decay (no new completions are assumed).
  const now = new Date();
  const months: { key: string; label: string; asOf: Date; projected: boolean }[] = [];
  for (let i = 11; i >= -12; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59);
    months.push({
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
      label: start.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
      asOf: end,
      projected: i < 0,
    });
  }

  // Group by program + specialisation
  const groupKey = (r: Row) => `${r.programName}__${r.specialisation.name}`;
  const byKey = new Map<string, Row[]>();
  for (const r of data) {
    const k = groupKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }

  // For efficiency, union the titles needed across all groups so we run one DB
  // query per snapshot (rather than one per group per snapshot).
  const allTitles = extractTitles(data.filter((r) => r.trainingTitle));

  type Snapshot = {
    program: string;
    specialisation: string;
    monthKey: string;
    monthLabel: string;
    attained: number;
    required: number;
    compliancePct: number;
    projected: boolean;
  };
  const snapshots: Snapshot[] = [];

  for (const m of months) {
    const emailSets = await getEmailSetsByTitle(allTitles, m.asOf, geoScope);
    for (const [k, reqs] of byKey) {
      const [program, specialisation] = k.split("__");
      let totalAttained = 0;
      let totalRequired = 0;
      for (const req of reqs) {
        if (!req.trainingTitle) continue;
        totalRequired += req.quantityRequired;
        const a = unionAttained(req, emailSets);
        totalAttained += Math.min(a, req.quantityRequired);
      }
      snapshots.push({
        program,
        specialisation,
        monthKey: m.key,
        monthLabel: m.label,
        attained: totalAttained,
        required: totalRequired,
        compliancePct: totalRequired === 0 ? 0 : (totalAttained / totalRequired) * 100,
        projected: m.projected,
      });
    }
  }

  const programs = [...new Set(data.map((r) => r.programName))].sort();
  const specialisations = [...new Set(data.map((r) => r.specialisation.name))].sort();

  return { snapshots, programs, specialisations, scopeLabel, unsupportedPrograms, partialPrograms };
}
