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

  // Group by fullTitle and aggregate student counts
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
    const existing = grouped.get(td.fullTitle);
    const count = new Set(td.trainingsTaken.map((t) => t.email)).size;

    if (existing) {
      // Merge: add student counts (collect all unique emails)
      const allEmails = new Set<string>();
      // Re-count from all training titles with this full title
      for (const other of trainingData) {
        if (other.fullTitle === td.fullTitle) {
          for (const t of other.trainingsTaken) {
            allEmails.add(t.email);
          }
        }
      }
      existing.studentsTaken = allEmails.size;
    } else {
      grouped.set(td.fullTitle, {
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
      certification: certification || null,
    },
  });

  return NextResponse.json(training, { status: 201 });
}
