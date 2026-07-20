import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";
import { countriesInRegion } from "@/lib/program-compliance";

type TrainingRecord = {
  email: string;
  completedDate: Date;
  expiryDate: Date;
  trainingData: {
    trainingType: string;
    productType: { name: string };
    function: string;
    fullTitle: string;
  };
};

type TypeLabel = "Certification" | "Accreditation" | "Instructor-Led Training" | "OLX";

function getTypeLabel(trainingType: string): TypeLabel {
  if (trainingType === "Certification") return "Certification";
  if (trainingType === "Accreditation") return "Accreditation";
  if (trainingType === "OLX") return "OLX";
  return "Instructor-Led Training";
}

function computeChartData(allTrainingTaken: TrainingRecord[]) {
  const now = new Date();

  // --- Breakdown by Product Type ---
  // Product types are an admin-managed list, so derive the buckets from the
  // data rather than a fixed set.
  const byProductType: Record<string, { Certification: number; Accreditation: number; "Instructor-Led Training": number; OLX: number }> = {};
  for (const tt of allTrainingTaken) {
    const pt = tt.trainingData.productType.name;
    if (!byProductType[pt]) {
      byProductType[pt] = { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 };
    }
    byProductType[pt][getTypeLabel(tt.trainingData.trainingType)]++;
  }

  // --- Breakdown by Function ---
  const FUNCTION_LABELS: Record<string, string> = {
    Sales: "Sales",
    PreSales: "Pre-Sales",
    Deployments: "Deployments",
  };
  const byFunction: Record<string, { Certification: number; Accreditation: number; "Instructor-Led Training": number; OLX: number }> = {};
  for (const fn of Object.keys(FUNCTION_LABELS)) {
    byFunction[FUNCTION_LABELS[fn]] = { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 };
  }
  for (const tt of allTrainingTaken) {
    const fnLabel = FUNCTION_LABELS[tt.trainingData.function] || tt.trainingData.function;
    if (byFunction[fnLabel]) {
      byFunction[fnLabel][getTypeLabel(tt.trainingData.trainingType)]++;
    }
  }

  // --- Expiring in 1, 3, 6 months ---
  const oneMonth = new Date(now);
  oneMonth.setMonth(oneMonth.getMonth() + 1);
  const threeMonths = new Date(now);
  threeMonths.setMonth(threeMonths.getMonth() + 3);
  const sixMonths = new Date(now);
  sixMonths.setMonth(sixMonths.getMonth() + 6);

  const expiryBuckets = {
    "1 Month": { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 },
    "3 Months": { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 },
    "6 Months": { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 },
  };

  for (const tt of allTrainingTaken) {
    const expiry = tt.expiryDate;
    if (expiry <= now) continue;
    const label = getTypeLabel(tt.trainingData.trainingType);
    if (expiry <= oneMonth) expiryBuckets["1 Month"][label]++;
    if (expiry <= threeMonths) expiryBuckets["3 Months"][label]++;
    if (expiry <= sixMonths) expiryBuckets["6 Months"][label]++;
  }

  // --- Achieved over last 12 months ---
  const monthlyAchieved: {
    month: string;
    Certification: number;
    Accreditation: number;
    "Instructor-Led Training": number;
    OLX: number;
  }[] = [];

  for (let i = 11; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const monthLabel = start.toLocaleDateString("en-US", { year: "numeric", month: "short" });
    const bucket = { month: monthLabel, Certification: 0, Accreditation: 0, "Instructor-Led Training": 0, OLX: 0 };

    for (const tt of allTrainingTaken) {
      if (tt.completedDate >= start && tt.completedDate < end) {
        bucket[getTypeLabel(tt.trainingData.trainingType)]++;
      }
    }
    monthlyAchieved.push(bucket);
  }

  return {
    byProductType: Object.entries(byProductType)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, counts]) => ({ name, ...counts })),
    byFunction: Object.entries(byFunction).map(([name, counts]) => ({ name, ...counts })),
    expiring: Object.entries(expiryBuckets).map(([name, counts]) => ({ name, ...counts })),
    monthlyAchieved,
  };
}

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));

  // Fail closed: caller has no access to the requested (or any) company.
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({
      theatres: [],
      metrics: {
        totalStudents: 0,
        certifications: 0,
        accreditations: 0,
        instructorLedTraining: 0,
        olx: 0,
        certificationStudents: 0,
        accreditationStudents: 0,
        instructorLedTrainingStudents: 0,
        olxStudents: 0,
      },
      byProductType: [],
      byFunction: [],
      expiring: [],
      monthlyAchieved: [],
    });
  }

  const rawTheatre = request.nextUrl.searchParams.get("theatre");
  const theatre = rawTheatre && rawTheatre !== "Global" ? rawTheatre : null;
  const region = request.nextUrl.searchParams.get("region") || null;
  const country = request.nextUrl.searchParams.get("country") || null;
  // Active-only by default: count just non-expired completions unless the
  // caller opts in to include inactive (expired) ones too.
  const includeInactive = request.nextUrl.searchParams.get("includeInactive") === "true";

  const body = await cachedReport(
    `dashboard|${scopeKey(companyFilter)}|${theatre || "Global"}|${region || ""}|${country || ""}|${includeInactive ? "all" : "active"}`,
    () => computeDashboard(companyFilter, theatre, region, country, includeInactive),
  );

  return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=30" } });
}

async function computeDashboard(
  companyFilter: number[] | null,
  theatre: string | null,
  region: string | null,
  country: string | null,
  includeInactive: boolean,
) {
  const companyStudentWhere = companyFilter ? { companyId: { in: companyFilter } } : {};

  // Fetch distinct theatres for the dropdown (scoped to allowed companies).
  // Retained for backward compatibility of the response shape; the client now
  // sources geo-filter options from the shared region-data list.
  const distinctTheatres = await prisma.student.findMany({
    select: { theatre: true },
    distinct: ["theatre"],
    orderBy: { theatre: "asc" },
    where: companyStudentWhere,
  });
  const theatres = distinctTheatres.map((s: typeof distinctTheatres[number]) => s.theatre);

  // Cascading theatre → region → country geo filter. Country is a direct
  // Student column; region is resolved to its member countries via the shared
  // `countriesInRegion` helper (the same approach the program/offering reports
  // use). The most specific level wins for the country clause (a specific
  // country implies its region), and the theatre clause always ANDs on top.
  const regionCountries = !country && region ? await countriesInRegion(region) : null;
  const geoStudentWhere = {
    ...(theatre ? { theatre } : {}),
    ...(country
      ? { country }
      : regionCountries
      ? { country: { in: regionCountries } }
      : {}),
  };
  const hasGeoFilter = Boolean(theatre || region || country);

  const studentWhere = { ...companyStudentWhere, ...geoStudentWhere };
  const trainingWhere = (hasGeoFilter || companyFilter)
    ? { student: { ...geoStudentWhere, ...(companyFilter ? { companyId: { in: companyFilter } } : {}) } }
    : {};

  // --- Top-level metrics ---
  const totalStudents = await prisma.student.count({ where: studentWhere });

  const rawTrainingTaken = await prisma.trainingTaken.findMany({
    include: { trainingData: { include: { productType: { select: { name: true } } } } },
    where: {
      // Sub-items roll up into the parent OLX. Exclude them from dashboard
      // counts to avoid double-counting.
      trainingData: { trainingType: { not: "OLXSubItem" } },
      ...trainingWhere,
    },
  });

  // Deduplicate: keep one record per student + fullTitle + trainingType (most recent)
  const dedupeMap = new Map<string, (typeof rawTrainingTaken)[number]>();
  for (const tt of rawTrainingTaken) {
    const key = `${tt.email}::${tt.trainingData.fullTitle}::${tt.trainingData.trainingType}`;
    const existing = dedupeMap.get(key);
    if (!existing || tt.completedDate > existing.completedDate) {
      dedupeMap.set(key, tt);
    }
  }
  // Active-only by default: keep just non-expired completions (the dedupe
  // already picked the most-recent row per email+fullTitle+type, so a row is
  // "active" when that latest completion hasn't expired). `includeInactive`
  // keeps expired rows too. Applied before the type counts and chart data so
  // every card + chart honours the toggle.
  const nowForActive = new Date();
  const allTrainingTaken = Array.from(dedupeMap.values()).filter(
    (tt) => includeInactive || tt.expiryDate > nowForActive,
  );

  // Count by type
  let certCount = 0;
  let accredCount = 0;
  let iltCount = 0;
  let olxCount = 0;
  const certStudents = new Set<string>();
  const accredStudents = new Set<string>();
  const iltStudents = new Set<string>();
  const olxStudents = new Set<string>();
  for (const tt of allTrainingTaken) {
    switch (tt.trainingData.trainingType) {
      case "Certification":
        certCount++;
        certStudents.add(tt.email);
        break;
      case "Accreditation":
        accredCount++;
        accredStudents.add(tt.email);
        break;
      case "InstructorLedTraining":
        iltCount++;
        iltStudents.add(tt.email);
        break;
      case "OLX":
        olxCount++;
        olxStudents.add(tt.email);
        break;
    }
  }

  const chartData = computeChartData(allTrainingTaken);

  return {
    theatres,
    metrics: {
      totalStudents,
      certifications: certCount,
      accreditations: accredCount,
      instructorLedTraining: iltCount,
      olx: olxCount,
      certificationStudents: certStudents.size,
      accreditationStudents: accredStudents.size,
      instructorLedTrainingStudents: iltStudents.size,
      olxStudents: olxStudents.size,
    },
    ...chartData,
  };
}
