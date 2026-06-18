import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
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
 * Historical months are now genuinely point-in-time (getEmailSetsByTitle
 * filters completedDate <= asOf as well as expiryDate > asOf). Future months
 * (`projected: true`) reuse the same logic with a future asOf, so compliance
 * decays as active certifications expire — an "if nothing else is completed"
 * forecast. No new completions are assumed.
 *
 * By default we evaluate at the Global level for each program, but the report
 * can be narrowed by theatre / region / country via query params.
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
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({ snapshots: [], programs: [], specialisations: [], scopeLabel: "Global · all theatres" });
  }

  const programFilter = request.nextUrl.searchParams.get("program");

  // Optional geographic scope (narrowest selection wins: country > region > theatre).
  const countryParam = request.nextUrl.searchParams.get("country") || "";
  const regionParam = request.nextUrl.searchParams.get("region") || "";
  const theatreParam = request.nextUrl.searchParams.get("theatre") || "";
  const geoScope: ComplianceScope = { companyIds: companyFilter };
  let scopeLabel = "Global · all theatres";
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

  const data = await prisma.programData.findMany({
    where: programFilter ? { programName: programFilter } : undefined,
    include: {
      specialisation: true,
      trainingData: { select: { fullTitle: true } },
      alternatives: { include: { trainingData: { select: { fullTitle: true } } } },
    },
  });

  type Row = typeof data[number];

  if (data.length === 0) {
    return NextResponse.json({ snapshots: [], programs: [], specialisations: [], scopeLabel });
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

  return NextResponse.json({ snapshots, programs, specialisations, scopeLabel });
}
