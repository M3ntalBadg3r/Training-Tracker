import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

/**
 * Per-fullTitle catalogue health metrics:
 * - totalCompletions: all-time count of TrainingTaken rows mapped to this fullTitle
 * - last12mo: completions in the trailing 12 months
 * - active: distinct students with an active (non-expired) record
 * - expiring90d: distinct students whose active record expires within 90 days
 * - uptakePct: active distinct students / total students globally
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const now = new Date();
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
  const ninetyDays = new Date(now);
  ninetyDays.setDate(ninetyDays.getDate() + 90);

  const totalStudents = await prisma.student.count();

  const records = await prisma.trainingTaken.findMany({
    include: {
      trainingData: {
        select: {
          fullTitle: true,
          trainingType: true,
          productType: true,
          function: true,
        },
      },
    },
  });

  const TYPE_LABELS: Record<string, string> = {
    Certification: "Certification",
    Accreditation: "Accreditation",
    InstructorLedTraining: "Instructor-Led Training",
  };
  const FUNC_LABELS: Record<string, string> = {
    Sales: "Sales",
    PreSales: "Pre-Sales",
    Deployments: "Deployments",
  };

  type Bucket = {
    fullTitle: string;
    productType: string;
    trainingType: string;
    function: string;
    totalCompletions: number;
    last12mo: number;
    activeEmails: Set<string>;
    expiring90dEmails: Set<string>;
  };
  const map = new Map<string, Bucket>();

  for (const r of records) {
    const ft = r.trainingData.fullTitle;
    let b = map.get(ft);
    if (!b) {
      b = {
        fullTitle: ft,
        productType: r.trainingData.productType,
        trainingType: TYPE_LABELS[r.trainingData.trainingType] ?? r.trainingData.trainingType,
        function: FUNC_LABELS[r.trainingData.function] ?? r.trainingData.function,
        totalCompletions: 0,
        last12mo: 0,
        activeEmails: new Set(),
        expiring90dEmails: new Set(),
      };
      map.set(ft, b);
    }
    b.totalCompletions++;
    if (r.completedDate >= twelveMonthsAgo) b.last12mo++;
    if (r.expiryDate > now) {
      b.activeEmails.add(r.email);
      if (r.expiryDate <= ninetyDays) b.expiring90dEmails.add(r.email);
    }
  }

  // Also include trainings with zero completions, so admins can spot dead catalogue items.
  const allTrainings = await prisma.trainingData.findMany({
    select: { fullTitle: true, productType: true, trainingType: true, function: true },
  });
  const seen = new Set<string>(map.keys());
  for (const t of allTrainings) {
    if (seen.has(t.fullTitle)) continue;
    seen.add(t.fullTitle);
    map.set(t.fullTitle, {
      fullTitle: t.fullTitle,
      productType: t.productType,
      trainingType: TYPE_LABELS[t.trainingType] ?? t.trainingType,
      function: FUNC_LABELS[t.function] ?? t.function,
      totalCompletions: 0,
      last12mo: 0,
      activeEmails: new Set(),
      expiring90dEmails: new Set(),
    });
  }

  const rows = Array.from(map.values()).map((b) => ({
    fullTitle: b.fullTitle,
    productType: b.productType,
    trainingType: b.trainingType,
    function: b.function,
    totalCompletions: b.totalCompletions,
    last12mo: b.last12mo,
    activeStudents: b.activeEmails.size,
    expiring90d: b.expiring90dEmails.size,
    uptakePct: totalStudents === 0 ? 0 : (b.activeEmails.size / totalStudents) * 100,
    zeroUptake: b.totalCompletions === 0,
  }));

  rows.sort((a, b) => b.totalCompletions - a.totalCompletions || a.fullTitle.localeCompare(b.fullTitle));

  return NextResponse.json({ rows, totalStudents });
}
