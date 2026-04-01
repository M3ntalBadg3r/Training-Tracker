import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

type TrainingRecord = {
  email: string;
  completedDate: Date;
  expiryDate: Date;
  trainingData: {
    trainingType: string;
    productType: string;
    function: string;
    fullTitle: string;
  };
};

function getTypeLabel(trainingType: string): "Certification" | "Accreditation" | "Instructor-Led Training" {
  return trainingType === "Certification"
    ? "Certification"
    : trainingType === "Accreditation"
      ? "Accreditation"
      : "Instructor-Led Training";
}

function computeChartData(allTrainingTaken: TrainingRecord[]) {
  const now = new Date();

  // --- Breakdown by Product Type ---
  const productTypes = ["Cortex", "SASE", "Cloud", "Strata", "Foundation"];
  const byProductType: Record<string, { Certification: number; Accreditation: number; "Instructor-Led Training": number }> = {};
  for (const pt of productTypes) {
    byProductType[pt] = { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0 };
  }
  for (const tt of allTrainingTaken) {
    const pt = tt.trainingData.productType;
    if (byProductType[pt]) {
      byProductType[pt][getTypeLabel(tt.trainingData.trainingType)]++;
    }
  }

  // --- Breakdown by Function ---
  const FUNCTION_LABELS: Record<string, string> = {
    Sales: "Sales",
    PreSales: "Pre-Sales",
    Deployments: "Deployments",
  };
  const byFunction: Record<string, { Certification: number; Accreditation: number; "Instructor-Led Training": number }> = {};
  for (const fn of Object.keys(FUNCTION_LABELS)) {
    byFunction[FUNCTION_LABELS[fn]] = { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0 };
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
    "1 Month": { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0 },
    "3 Months": { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0 },
    "6 Months": { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0 },
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
  }[] = [];

  for (let i = 11; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const monthLabel = start.toLocaleDateString("en-US", { year: "numeric", month: "short" });
    const bucket = { month: monthLabel, Certification: 0, Accreditation: 0, "Instructor-Led Training": 0 };

    for (const tt of allTrainingTaken) {
      if (tt.completedDate >= start && tt.completedDate < end) {
        bucket[getTypeLabel(tt.trainingData.trainingType)]++;
      }
    }
    monthlyAchieved.push(bucket);
  }

  return {
    byProductType: productTypes.map((pt) => ({ name: pt, ...byProductType[pt] })),
    byFunction: Object.entries(byFunction).map(([name, counts]) => ({ name, ...counts })),
    expiring: Object.entries(expiryBuckets).map(([name, counts]) => ({ name, ...counts })),
    monthlyAchieved,
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const theatre = request.nextUrl.searchParams.get("theatre");
  const filterByTheatre = theatre && theatre !== "Global";

  // Fetch distinct theatres for the dropdown
  const distinctTheatres = await prisma.student.findMany({
    select: { theatre: true },
    distinct: ["theatre"],
    orderBy: { theatre: "asc" },
  });
  const theatres = distinctTheatres.map((s: typeof distinctTheatres[number]) => s.theatre);

  // Theatre filter for Prisma queries
  const studentWhere = filterByTheatre ? { theatre } : {};
  const trainingWhere = filterByTheatre ? { student: { theatre } } : {};

  // --- Top-level metrics ---
  const totalStudents = await prisma.student.count({ where: studentWhere });

  const rawTrainingTaken = await prisma.trainingTaken.findMany({
    include: { trainingData: true },
    where: trainingWhere,
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
  const allTrainingTaken = Array.from(dedupeMap.values());

  // Count by type
  let certCount = 0;
  let accredCount = 0;
  let iltCount = 0;
  for (const tt of allTrainingTaken) {
    switch (tt.trainingData.trainingType) {
      case "Certification": certCount++; break;
      case "Accreditation": accredCount++; break;
      case "InstructorLedTraining": iltCount++; break;
    }
  }

  const chartData = computeChartData(allTrainingTaken);

  return NextResponse.json({
    theatres,
    metrics: {
      totalStudents,
      certifications: certCount,
      accreditations: accredCount,
      instructorLedTraining: iltCount,
    },
    ...chartData,
  });
}
