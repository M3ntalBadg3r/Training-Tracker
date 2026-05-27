import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  // End-of-today boundary: anything strictly later is "in the future".
  const now = new Date();
  const endOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999
  );

  type Row = {
    id: number;
    email: string;
    trainingTitle: string;
    completedDate: Date;
    expiryDate: Date;
    student: { fullName: string; companyId: number };
    trainingData: { fullTitle: string; trainingType: string };
  };

  const rows = (await prisma.trainingTaken.findMany({
    where: { completedDate: { gt: endOfToday } },
    include: {
      student: { select: { fullName: true, companyId: true } },
      trainingData: { select: { fullTitle: true, trainingType: true } },
    },
    orderBy: { completedDate: "desc" },
  })) as Row[];

  const items = rows.map((r) => ({
    id: r.id,
    email: r.email,
    fullName: r.student.fullName,
    companyId: r.student.companyId,
    trainingTitle: r.trainingTitle,
    fullTitle: r.trainingData.fullTitle,
    trainingType: r.trainingData.trainingType,
    completedDate: toIsoDate(r.completedDate),
    expiryDate: toIsoDate(r.expiryDate),
  }));

  return NextResponse.json({
    items,
    today: toIsoDate(now),
  });
}
