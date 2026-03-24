import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { TrainingType, ProductType, FunctionType } from "@prisma/client";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const theatre = searchParams.get("theatre");
  const region = searchParams.get("region");
  const country = searchParams.get("country");

  // Build a where clause for trainingsTaken → student filtering
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const studentWhere: Record<string, any> = {};
  if (theatre) studentWhere.theatre = theatre;
  if (country) studentWhere.country = country;
  if (region) studentWhere.regionData = { region };

  const hasFilters = Object.keys(studentWhere).length > 0;

  const trainingData = await prisma.trainingData.findMany({
    include: {
      trainingsTaken: {
        include: { student: hasFilters ? { include: { regionData: true } } : false },
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

  // Helper to check if a training-taken record's student matches the filters
  const matchesFilter = (t: (typeof trainingData)[number]["trainingsTaken"][number]): boolean => {
    if (!hasFilters) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const student = (t as any).student;
    if (!student) return false;
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
        td.trainingsTaken.filter(matchesFilter).map((t) => t.email)
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
  if (hasFilters) {
    results = results.filter((r) => r.studentsTaken > 0);
  }
  return NextResponse.json(results);
}

export async function POST(request: NextRequest) {
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
