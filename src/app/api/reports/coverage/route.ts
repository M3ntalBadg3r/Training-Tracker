import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";
import { resolveBucket, GroupByMode } from "@/lib/group-by";

/**
 * Coverage / compliance by theatre|region|country.
 * Returns one row per (bucket, productType, trainingType) with the count of
 * students in that bucket who hold an active training of that type for that
 * product, plus the total student population in the bucket.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({ rows: [], buckets: [], totalStudents: 0 });
  }

  const mode = (request.nextUrl.searchParams.get("groupBy") as GroupByMode) || "theatre";

  const studentScope = companyFilter ? { companyId: { in: companyFilter } } : {};

  const students = await prisma.student.findMany({
    where: studentScope,
    select: {
      email: true,
      theatre: true,
      country: true,
      regionData: { select: { region: true } },
    },
  });

  const studentByBucket = new Map<string, Set<string>>();
  const emailToBucket = new Map<string, string>();
  for (const s of students) {
    const bucket = resolveBucket(
      { theatre: s.theatre, region: s.regionData?.region ?? null, country: s.country },
      mode
    );
    emailToBucket.set(s.email, bucket);
    if (!studentByBucket.has(bucket)) studentByBucket.set(bucket, new Set());
    studentByBucket.get(bucket)!.add(s.email);
  }

  const now = new Date();
  const activeTrainings = await prisma.trainingTaken.findMany({
    where: {
      expiryDate: { gt: now },
      // Sub-items are excluded — coverage measures parent-level completion.
      trainingData: { trainingType: { not: "OLXSubItem" } },
      ...(companyFilter ? { student: { companyId: { in: companyFilter } } } : {}),
    },
    select: {
      email: true,
      trainingData: { select: { productType: true, trainingType: true } },
    },
  });

  const TYPE_LABELS: Record<string, string> = {
    Certification: "Certification",
    Accreditation: "Accreditation",
    InstructorLedTraining: "Instructor-Led Training",
    OLX: "OLX",
  };

  // bucket -> product -> type -> Set<email>
  const cube = new Map<string, Map<string, Map<string, Set<string>>>>();
  for (const t of activeTrainings) {
    const bucket = emailToBucket.get(t.email);
    if (!bucket) continue;
    const product = t.trainingData.productType;
    const type = TYPE_LABELS[t.trainingData.trainingType] ?? t.trainingData.trainingType;
    let byProduct = cube.get(bucket);
    if (!byProduct) { byProduct = new Map(); cube.set(bucket, byProduct); }
    let byType = byProduct.get(product);
    if (!byType) { byType = new Map(); byProduct.set(product, byType); }
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type)!.add(t.email);
  }

  type Row = {
    bucket: string;
    product: string;
    trainingType: string;
    attained: number;
    totalInBucket: number;
    coveragePct: number;
  };
  const rows: Row[] = [];

  for (const [bucket, byProduct] of cube) {
    const totalInBucket = studentByBucket.get(bucket)?.size ?? 0;
    for (const [product, byType] of byProduct) {
      for (const [type, emails] of byType) {
        rows.push({
          bucket,
          product,
          trainingType: type,
          attained: emails.size,
          totalInBucket,
          coveragePct: totalInBucket === 0 ? 0 : (emails.size / totalInBucket) * 100,
        });
      }
    }
  }

  rows.sort(
    (a, b) =>
      a.bucket.localeCompare(b.bucket) ||
      a.product.localeCompare(b.product) ||
      a.trainingType.localeCompare(b.trainingType)
  );

  const buckets = Array.from(studentByBucket.keys()).sort();
  return NextResponse.json({ rows, buckets, totalStudents: students.length });
}
