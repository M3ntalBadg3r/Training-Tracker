import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { TrainingType, ProductType, FunctionType } from "@prisma/client";

export async function GET() {
  const trainingData = await prisma.trainingData.findMany({
    include: {
      trainingsTaken: true,
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

  for (const td of trainingData) {
    const groupKey = `${td.fullTitle}::${td.trainingType}`;
    const existing = grouped.get(groupKey);
    const count = new Set(td.trainingsTaken.map((t) => t.email)).size;

    if (existing) {
      // Merge: collect all unique emails across training titles with same fullTitle AND trainingType
      const allEmails = new Set<string>();
      for (const other of trainingData) {
        if (other.fullTitle === td.fullTitle && other.trainingType === td.trainingType) {
          for (const t of other.trainingsTaken) {
            allEmails.add(t.email);
          }
        }
      }
      existing.studentsTaken = allEmails.size;
    } else {
      grouped.set(groupKey, {
        fullTitle: td.fullTitle,
        trainingType: td.trainingType,
        productType: td.productType,
        function: td.function,
        link: td.link,
        studentsTaken: count,
      });
    }
  }

  return NextResponse.json(Array.from(grouped.values()));
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
