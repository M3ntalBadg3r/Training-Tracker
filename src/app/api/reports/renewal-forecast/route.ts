import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";

/**
 * Renewal forecast.
 *
 * "Renewal" rule: for a given (email, fullTitle) timeline of TrainingTaken
 * rows ordered by completedDate, any later re-completion of the same training
 * counts as a renewal of the previous one (the learner came back to it),
 * provided the follow-up is at least 30 days later so near-duplicate rows
 * aren't double-counted. The final row in a timeline is treated as a lapse
 * only once it has actually expired with no follow-up.
 *
 * Renewal rate selection per fullTitle:
 *   if ≥5 historical expiries → use per-fullTitle rate
 *   else if ≥5 per its productType → fallback to per-product
 *   else → global rate
 *
 * Forecast: sum of upcoming expiries (next 6 + 12 months) split into
 * projectedRenewed (rate × count) and projectedLapsed.
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

  // Geographic scope (narrowest wins: country → region → theatre).
  const countryParam = request.nextUrl.searchParams.get("country") || "";
  const regionParam = request.nextUrl.searchParams.get("region") || "";
  const theatreParam = request.nextUrl.searchParams.get("theatre") || "";
  let scopeLabel = "All theatres";
  if (countryParam) scopeLabel = `Country: ${countryParam}`;
  else if (regionParam) scopeLabel = `Region: ${regionParam}`;
  else if (theatreParam) scopeLabel = `Theatre: ${theatreParam}`;

  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({ monthly: [], titleRows: [], globalRate: 0, historicalRenewed: 0, historicalLapsed: 0, scopeLabel });
  }

  const now = new Date();
  const horizonEnd = new Date(now);
  horizonEnd.setFullYear(horizonEnd.getFullYear() + 1);

  // Combine company + geographic scope into a single student filter.
  const studentWhere: Prisma.StudentWhereInput = {};
  if (companyFilter) studentWhere.companyId = { in: companyFilter };
  if (countryParam) studentWhere.country = countryParam;
  else if (regionParam) studentWhere.regionData = { region: regionParam };
  else if (theatreParam) studentWhere.theatre = theatreParam;
  const hasStudentFilter = Object.keys(studentWhere).length > 0;

  const records = await prisma.trainingTaken.findMany({
    where: {
      // Sub-items roll up into the parent OLX, which carries the canonical
      // expiry. Exclude them from the renewal forecast.
      trainingData: { trainingType: { not: "OLXSubItem" } },
      ...(hasStudentFilter ? { student: studentWhere } : {}),
    },
    include: {
      trainingData: { select: { fullTitle: true, productType: { select: { name: true } }, trainingType: true } },
    },
    orderBy: [{ email: "asc" }, { trainingTitle: "asc" }, { completedDate: "asc" }],
  });

  // Build per-(email, fullTitle) timelines using fullTitle (multiple trainingTitles can map to one fullTitle)
  const timelines = new Map<string, { completedDate: Date; expiryDate: Date; productType: string }[]>();
  for (const r of records) {
    const k = `${r.email}::${r.trainingData.fullTitle}`;
    if (!timelines.has(k)) timelines.set(k, []);
    timelines.get(k)!.push({
      completedDate: r.completedDate,
      expiryDate: r.expiryDate,
      productType: r.trainingData.productType.name,
    });
  }

  // Build the historical (renewed, lapsed) tally per fullTitle and per product.
  type Tally = { renewed: number; lapsed: number };
  const perFullTitle = new Map<string, Tally>();
  const perProduct = new Map<string, Tally>();
  let globalRenewed = 0;
  let globalLapsed = 0;

  // We need fullTitle <-> product links — derive from the records we have.
  const fullTitleProduct = new Map<string, string>();
  for (const r of records) fullTitleProduct.set(r.trainingData.fullTitle, r.trainingData.productType.name);

  // A re-completion that lands at least this far after the previous one counts
  // as a genuine renewal. The gap guards against near-duplicate rows created
  // when several trainingTitles roll up to a single fullTitle.
  const MIN_RENEWAL_GAP = 30 * 24 * 60 * 60 * 1000;

  for (const [k, timeline] of timelines) {
    if (timeline.length === 0) continue;
    const fullTitle = k.split("::").slice(1).join("::");
    timeline.sort((a, b) => a.completedDate.getTime() - b.completedDate.getTime());
    const product = timeline[0].productType;

    for (let i = 0; i < timeline.length; i++) {
      const cur = timeline[i];
      const next = timeline[i + 1];
      if (next) {
        // Any later re-completion of the same training means the learner came
        // back and renewed it — regardless of exactly when relative to expiry.
        // Skip pairs that are effectively the same event (near-duplicate rows).
        if (next.completedDate.getTime() - cur.completedDate.getTime() >= MIN_RENEWAL_GAP) {
          tallyAdd(perFullTitle, fullTitle, "renewed");
          tallyAdd(perProduct, product, "renewed");
          globalRenewed++;
        }
      } else if (cur.expiryDate < now) {
        // Final record with no follow-up and already expired → the learner let
        // it lapse without re-taking it.
        tallyAdd(perFullTitle, fullTitle, "lapsed");
        tallyAdd(perProduct, product, "lapsed");
        globalLapsed++;
      }
    }
  }

  function tallyAdd(map: Map<string, Tally>, k: string, kind: keyof Tally) {
    const t = map.get(k) ?? { renewed: 0, lapsed: 0 };
    t[kind]++;
    map.set(k, t);
  }

  const globalTotal = globalRenewed + globalLapsed;
  const globalRate = globalTotal === 0 ? 0.5 : globalRenewed / globalTotal;

  function rateFor(fullTitle: string): { rate: number; source: "title" | "product" | "global" } {
    const t = perFullTitle.get(fullTitle);
    const total = (t?.renewed ?? 0) + (t?.lapsed ?? 0);
    if (total >= 5) return { rate: t!.renewed / total, source: "title" };
    const product = fullTitleProduct.get(fullTitle);
    if (product) {
      const p = perProduct.get(product);
      const ptotal = (p?.renewed ?? 0) + (p?.lapsed ?? 0);
      if (ptotal >= 5) return { rate: p!.renewed / ptotal, source: "product" };
    }
    return { rate: globalRate, source: "global" };
  }

  // Build upcoming expiries — for each (email, fullTitle), find the latest
  // record; if its expiry is in the next 12 months and there's no later record
  // already covering it, count it as upcoming.
  type Upcoming = { fullTitle: string; productType: string; expiryDate: Date };
  const upcoming: Upcoming[] = [];
  for (const [k, timeline] of timelines) {
    if (timeline.length === 0) continue;
    const fullTitle = k.split("::").slice(1).join("::");
    const last = timeline[timeline.length - 1];
    if (last.expiryDate > now && last.expiryDate <= horizonEnd) {
      upcoming.push({ fullTitle, productType: last.productType, expiryDate: last.expiryDate });
    }
  }

  // Build monthly buckets for next 12 months
  const months: { key: string; label: string; from: Date; to: Date }[] = [];
  for (let i = 0; i < 12; i++) {
    const start = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59);
    months.push({
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
      label: start.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
      from: start,
      to: end,
    });
  }

  type MonthRow = {
    monthKey: string;
    monthLabel: string;
    expiringCount: number;
    projectedRenewed: number;
    projectedLapsed: number;
  };
  const monthly: MonthRow[] = months.map((m) => ({
    monthKey: m.key,
    monthLabel: m.label,
    expiringCount: 0,
    projectedRenewed: 0,
    projectedLapsed: 0,
  }));

  // Per-fullTitle aggregate for at-risk leaderboard
  type TitleAgg = { fullTitle: string; productType: string; expiringCount: number; rate: number; rateSource: string; projectedLapsed: number };
  const titleAggMap = new Map<string, TitleAgg>();

  for (const u of upcoming) {
    const idx = months.findIndex((m) => u.expiryDate >= m.from && u.expiryDate <= m.to);
    if (idx === -1) continue;
    const { rate, source } = rateFor(u.fullTitle);
    monthly[idx].expiringCount++;
    monthly[idx].projectedRenewed += rate;
    monthly[idx].projectedLapsed += 1 - rate;

    let agg = titleAggMap.get(u.fullTitle);
    if (!agg) {
      agg = { fullTitle: u.fullTitle, productType: u.productType, expiringCount: 0, rate, rateSource: source, projectedLapsed: 0 };
      titleAggMap.set(u.fullTitle, agg);
    }
    agg.expiringCount++;
    agg.projectedLapsed += 1 - rate;
  }

  // Round projections to whole records
  for (const m of monthly) {
    m.projectedRenewed = Math.round(m.projectedRenewed);
    m.projectedLapsed = Math.round(m.projectedLapsed);
  }

  const titleRows = Array.from(titleAggMap.values()).map((a) => ({
    ...a,
    rate: Number((a.rate * 100).toFixed(1)),
    projectedLapsed: Math.round(a.projectedLapsed),
  }));
  titleRows.sort((a, b) => b.projectedLapsed - a.projectedLapsed);

  return NextResponse.json({
    monthly,
    titleRows,
    globalRate: Number((globalRate * 100).toFixed(1)),
    historicalRenewed: globalRenewed,
    historicalLapsed: globalLapsed,
    scopeLabel,
  });
}
