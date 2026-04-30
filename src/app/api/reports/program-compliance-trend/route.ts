import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import {
  extractTitles,
  getEmailSetsByTitle,
  unionAttained,
} from "@/lib/program-compliance";

/**
 * Program compliance trend over the last 12 months.
 *
 * For each (program, specialisation) pair, we compute monthly snapshots: at
 * each month-end we re-run the same union-of-primary-and-alternatives logic
 * with `asOf` set to that month-end, and report attained/required per
 * requirement plus an aggregate compliance ratio for the specialisation
 * (sum of attained, capped at sum of required).
 *
 * For tractability we evaluate at the Global level for both APS Global and
 * Global Diamond — the full country/theatre breakdown would be expensive over
 * 12 snapshots and isn't typically asked of trend reports.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const programFilter = request.nextUrl.searchParams.get("program");

  const data = await prisma.programData.findMany({
    where: programFilter ? { programName: programFilter } : undefined,
    include: {
      specialisation: true,
      trainingData: { select: { fullTitle: true } },
      alternatives: { include: { trainingData: { select: { fullTitle: true } } } },
    },
  });

  type Row = typeof data[number];

  if (data.length === 0) {
    return NextResponse.json({ snapshots: [], programs: [], specialisations: [] });
  }

  // Build month boundaries (last 12 months including current)
  const now = new Date();
  const months: { key: string; label: string; asOf: Date }[] = [];
  for (let i = 11; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59);
    months.push({
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
      label: start.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
      asOf: end,
    });
  }

  // Group by program + specialisation
  const groupKey = (r: Row) => `${r.programName}__${r.specialisation.name}`;
  const byKey = new Map<string, Row[]>();
  for (const r of data) {
    const k = groupKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }

  // For efficiency, union the titles needed across all groups so we run one DB
  // query per snapshot (rather than one per group per snapshot).
  const allTitles = extractTitles(data.filter((r) => r.trainingTitle));

  type Snapshot = {
    program: string;
    specialisation: string;
    monthKey: string;
    monthLabel: string;
    attained: number;
    required: number;
    compliancePct: number;
  };
  const snapshots: Snapshot[] = [];

  for (const m of months) {
    const emailSets = await getEmailSetsByTitle(allTitles, m.asOf);
    for (const [k, reqs] of byKey) {
      const [program, specialisation] = k.split("__");
      let totalAttained = 0;
      let totalRequired = 0;
      for (const req of reqs) {
        if (!req.trainingTitle) continue;
        totalRequired += req.quantityRequired;
        const a = unionAttained(req, emailSets);
        totalAttained += Math.min(a, req.quantityRequired);
      }
      snapshots.push({
        program,
        specialisation,
        monthKey: m.key,
        monthLabel: m.label,
        attained: totalAttained,
        required: totalRequired,
        compliancePct: totalRequired === 0 ? 0 : (totalAttained / totalRequired) * 100,
      });
    }
  }

  const programs = [...new Set(data.map((r) => r.programName))].sort();
  const specialisations = [...new Set(data.map((r) => r.specialisation.name))].sort();

  return NextResponse.json({ snapshots, programs, specialisations });
}
