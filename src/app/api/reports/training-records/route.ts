import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { cachedReport, scopeKey } from "@/lib/report-cache";

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) return NextResponse.json([]);

  const records = await cachedReport(
    `training-records|${scopeKey(companyFilter)}`,
    () => computeTrainingRecords(companyFilter),
  );

  return NextResponse.json(records, { headers: { "Cache-Control": "private, max-age=30" } });
}

async function computeTrainingRecords(companyFilter: number[] | null) {
  const rawRecords = await prisma.trainingTaken.findMany({
    where: {
      // OLX sub-items aren't stand-alone completions — they roll up into the
      // parent OLX. Exclude them from completion-counting reports.
      trainingData: { trainingType: { not: "OLXSubItem" } },
      ...(companyFilter ? { student: { companyId: { in: companyFilter } } } : {}),
    },
    include: {
      trainingData: {
        select: {
          fullTitle: true,
          trainingType: true,
          productType: { select: { name: true } },
          function: true,
          isLegacy: true,
        },
      },
      student: {
        select: {
          fullName: true,
          theatre: true,
          country: true,
          regionData: { select: { region: true } },
        },
      },
    },
  });

  // Deduplicate: keep one record per student + fullTitle + trainingType (most recent)
  const dedupeMap = new Map<string, (typeof rawRecords)[number]>();
  for (const tt of rawRecords) {
    const key = `${tt.email}::${tt.trainingData.fullTitle}::${tt.trainingData.trainingType}`;
    const existing = dedupeMap.get(key);
    if (!existing || tt.completedDate > existing.completedDate) {
      dedupeMap.set(key, tt);
    }
  }

  const FUNCTION_LABELS: Record<string, string> = {
    Sales: "Sales",
    PreSales: "Pre-Sales",
    Deployments: "Deployments",
  };

  const TYPE_LABELS: Record<string, string> = {
    Certification: "Certification",
    Accreditation: "Accreditation",
    InstructorLedTraining: "Instructor-Led Training",
    OLX: "OLX",
    OLXSubItem: "OLX Sub-Item",
  };

  const now = new Date();
  return Array.from(dedupeMap.values()).map((tt) => ({
    fullName: tt.student.fullName,
    email: tt.email,
    theatre: tt.student.theatre,
    region: tt.student.regionData?.region ?? "",
    country: tt.student.country,
    trainingTitle: tt.trainingData.fullTitle,
    trainingType: TYPE_LABELS[tt.trainingData.trainingType] || tt.trainingData.trainingType,
    productType: tt.trainingData.productType.name,
    function: FUNCTION_LABELS[tt.trainingData.function] || tt.trainingData.function,
    completedDate: tt.completedDate.toISOString(),
    expiryDate: tt.expiryDate.toISOString(),
    active: tt.expiryDate > now,
    isLegacy: tt.trainingData.isLegacy,
  }));
}
