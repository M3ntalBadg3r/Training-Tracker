import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { TrainingType, ProductType, FunctionType } from "@prisma/client";
import { requireAuth, handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { searchParams } = request.nextUrl;
  const theatre = searchParams.get("theatre");
  const region = searchParams.get("region");
  const country = searchParams.get("country");

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json([]);
  }

  const hasLocationFilters = !!(theatre || region || country);
  // Need student data when location-filtering or when scoping by company
  const needsStudentData = hasLocationFilters || companyFilter !== null;

  const trainingData = await prisma.trainingData.findMany({
    include: {
      trainingsTaken: {
        include: {
          // student: false skips the join for unfiltered SuperAdmin queries (perf opt)
          student: needsStudentData
            ? (hasLocationFilters ? { include: { regionData: true } } : true)
            : false,
        },
      },
    },
    orderBy: { fullTitle: "asc" },
  });

  // Group by fullTitle + trainingType to avoid merging different types
  const grouped = new Map<
    string,
    {
      fullTitle: string;
      trainingType: string;
      productType: string;
      function: string;
      link: string | null;
      studentsTaken: number;
    }
  >();

  // Helper to check if a training-taken record's student matches all active filters
  const matchesFilter = (t: (typeof trainingData)[number]["trainingsTaken"][number]): boolean => {
    if (!needsStudentData) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const student = (t as any).student;
    if (!student) return false;
    if (companyFilter && !companyFilter.includes(student.companyId)) return false;
    if (theatre && student.theatre !== theatre) return false;
    if (country && student.country !== country) return false;
    if (region && student.regionData?.region !== region) return false;
    return true;
  };

  for (const td of trainingData) {
    const groupKey = `${td.fullTitle}::${td.trainingType}`;
    const existing = grouped.get(groupKey);

    if (existing) {
      // Merge: collect all unique emails across training titles with same fullTitle AND trainingType
      const allEmails = new Set<string>();
      for (const other of trainingData) {
        if (other.fullTitle === td.fullTitle && other.trainingType === td.trainingType) {
          for (const t of other.trainingsTaken) {
            if (matchesFilter(t)) allEmails.add(t.email);
          }
        }
      }
      existing.studentsTaken = allEmails.size;
    } else {
      const filteredEmails = new Set(
        td.trainingsTaken.filter(matchesFilter).map((t: typeof trainingData[number]["trainingsTaken"][number]) => t.email)
      );
      grouped.set(groupKey, {
        fullTitle: td.fullTitle,
        trainingType: td.trainingType,
        productType: td.productType,
        function: td.function,
        link: td.link,
        studentsTaken: filteredEmails.size,
      });
    }
  }

  let results = Array.from(grouped.values());
  if (hasLocationFilters) {
    results = results.filter((r) => r.studentsTaken > 0);
  }
  return NextResponse.json(results);
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const body = await request.json();
  const { trainingTitle, fullTitle, trainingType, productType, function: fn, link, certification } = body;

  if (!trainingTitle || !fullTitle || !trainingType || !productType || !fn) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  const training = await prisma.trainingData.create({
    data: {
      trainingTitle,
      fullTitle,
      trainingType: trainingType as TrainingType,
      productType: productType as ProductType,
      function: fn as FunctionType,
      link: link || null,
      certification: Array.isArray(certification) ? certification : [],
    },
  });

  return NextResponse.json(training, { status: 201 });
}
