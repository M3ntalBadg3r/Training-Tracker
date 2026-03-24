import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
  const now = new Date();

  // --- Top-level metrics ---
  const totalStudents = await prisma.student.count();

  // All training taken joined with training data for type info
  const rawTrainingTaken = await prisma.trainingTaken.findMany({
    include: { trainingData: true },
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

  let certCount = 0;
  let accredCount = 0;
  let iltCount = 0;

  for (const tt of allTrainingTaken) {
    switch (tt.trainingData.trainingType) {
      case "Certification":
        certCount++;
        break;
      case "Accreditation":
        accredCount++;
        break;
      case "InstructorLedTraining":
        iltCount++;
        break;
    }
  }

  // --- Breakdown by Product Type ---
  const byProductType: Record<string, { Certification: number; Accreditation: number; "Instructor-Led Training": number }> = {};
  const productTypes = ["Cortex", "SASE", "Cloud", "Strata", "Foundation"];
  for (const pt of productTypes) {
    byProductType[pt] = { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0 };
  }
  for (const tt of allTrainingTaken) {
    const pt = tt.trainingData.productType;
    const label =
      tt.trainingData.trainingType === "Certification"
        ? "Certification"
        : tt.trainingData.trainingType === "Accreditation"
          ? "Accreditation"
          : "Instructor-Led Training";
    if (byProductType[pt]) {
      byProductType[pt][label]++;
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
    const label = FUNCTION_LABELS[fn];
    byFunction[label] = { Certification: 0, Accreditation: 0, "Instructor-Led Training": 0 };
  }
  for (const tt of allTrainingTaken) {
    const fnLabel = FUNCTION_LABELS[tt.trainingData.function] || tt.trainingData.function;
    const typeLabel =
      tt.trainingData.trainingType === "Certification"
        ? "Certification"
        : tt.trainingData.trainingType === "Accreditation"
          ? "Accreditation"
          : "Instructor-Led Training";
    if (byFunction[fnLabel]) {
      byFunction[fnLabel][typeLabel]++;
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
    if (expiry <= now) continue; // already expired
    const typeLabel =
      tt.trainingData.trainingType === "Certification"
        ? "Certification"
        : tt.trainingData.trainingType === "Accreditation"
          ? "Accreditation"
          : "Instructor-Led Training";
    if (expiry <= oneMonth) {
      expiryBuckets["1 Month"][typeLabel]++;
    }
    if (expiry <= threeMonths) {
      expiryBuckets["3 Months"][typeLabel]++;
    }
    if (expiry <= sixMonths) {
      expiryBuckets["6 Months"][typeLabel]++;
    }
  }

  // --- Achieved over last 12 months (monthly) ---
  const monthlyAchieved: {
    month: string;
    Certification: number;
    Accreditation: number;
    "Instructor-Led Training": number;
  }[] = [];

  for (let i = 11; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const label = start.toLocaleDateString("en-US", { year: "numeric", month: "short" });

    const bucket = { month: label, Certification: 0, Accreditation: 0, "Instructor-Led Training": 0 };

    for (const tt of allTrainingTaken) {
      if (tt.completedDate >= start && tt.completedDate < end) {
        const typeLabel =
          tt.trainingData.trainingType === "Certification"
            ? "Certification"
            : tt.trainingData.trainingType === "Accreditation"
              ? "Accreditation"
              : "Instructor-Led Training";
        bucket[typeLabel]++;
      }
    }

    monthlyAchieved.push(bucket);
  }

  return NextResponse.json({
    metrics: {
      totalStudents,
      certifications: certCount,
      accreditations: accredCount,
      instructorLedTraining: iltCount,
    },
    byProductType: productTypes.map((pt) => ({
      name: pt,
      ...byProductType[pt],
    })),
    byFunction: Object.entries(byFunction).map(([name, counts]) => ({
      name,
      ...counts,
    })),
    expiring: Object.entries(expiryBuckets).map(([name, counts]) => ({
      name,
      ...counts,
    })),
    monthlyAchieved,
  });
}
