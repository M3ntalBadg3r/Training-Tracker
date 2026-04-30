import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { TrainingType } from "@prisma/client";
import { isActive, formatDate, parseDate, computeExpiryDate } from "@/lib/utils";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { searchParams } = new URL(request.url);
  const fullTitle = searchParams.get("fullTitle");
  const trainingType = searchParams.get("trainingType");

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json([]);
  }

  if (!fullTitle) {
    return NextResponse.json(
      { error: "fullTitle parameter required" },
      { status: 400 }
    );
  }

  // Find all training titles with this full title (and optionally trainingType)
  const where: { fullTitle: string; trainingType?: TrainingType } = { fullTitle };
  if (trainingType && Object.values(TrainingType).includes(trainingType as TrainingType)) {
    where.trainingType = trainingType as TrainingType;
  }

  const trainingDataRecords = await prisma.trainingData.findMany({
    where,
    select: { trainingTitle: true },
  });

  const trainingTitles = trainingDataRecords.map((td: typeof trainingDataRecords[number]) => td.trainingTitle);

  // Optional location filters
  const theatre = searchParams.get("theatre");
  const region = searchParams.get("region");
  const country = searchParams.get("country");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const studentWhere: Record<string, any> = {};
  if (theatre) studentWhere.theatre = theatre;
  if (country) studentWhere.country = country;
  if (region) studentWhere.regionData = { region };
  if (companyFilter) studentWhere.companyId = { in: companyFilter };

  // Find all training taken records with these titles
  const trainingTaken = await prisma.trainingTaken.findMany({
    where: {
      trainingTitle: { in: trainingTitles },
      ...(Object.keys(studentWhere).length > 0 ? { student: studentWhere } : {}),
    },
    include: {
      student: {
        include: { regionData: true },
      },
    },
    orderBy: { completedDate: "desc" },
  });

  // Deduplicate by student email, keeping the most recent record
  const byStudent = new Map<string, (typeof trainingTaken)[number]>();
  for (const t of trainingTaken) {
    const existing = byStudent.get(t.email);
    if (!existing || t.completedDate > existing.completedDate) {
      byStudent.set(t.email, t);
    }
  }

  const result = Array.from(byStudent.values()).map((t) => ({
    fullName: t.student.fullName,
    email: t.student.email,
    theatre: t.student.theatre,
    region: t.student.regionData?.region ?? "",
    country: t.student.country,
    active: isActive(t.expiryDate),
    completedDate: formatDate(t.completedDate),
    expiryDate: formatDate(t.expiryDate),
  }));

  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const { email, trainingTitle, completedDate } = body;

  if (!email || !trainingTitle || !completedDate) {
    return NextResponse.json(
      { error: "Missing required fields: email, trainingTitle, completedDate" },
      { status: 400 }
    );
  }
  if (
    typeof email !== "string" ||
    typeof trainingTitle !== "string" ||
    typeof completedDate !== "string"
  ) {
    return NextResponse.json({ error: "Invalid field types" }, { status: 400 });
  }

  const parsedCompleted = parseDate(completedDate);
  if (!parsedCompleted) {
    return NextResponse.json(
      { error: "Invalid completedDate" },
      { status: 400 }
    );
  }

  const student = await prisma.student.findUnique({ where: { email } });
  if (!student) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }
  if (!(await canAccessCompany(auth.sub, auth.role, student.companyId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const trainingData = await prisma.trainingData.findUnique({
    where: { trainingTitle },
  });
  if (!trainingData) {
    return NextResponse.json(
      { error: "Training not found" },
      { status: 404 }
    );
  }

  const existing = await prisma.trainingTaken.findFirst({
    where: { email, trainingTitle, completedDate: parsedCompleted },
  });
  if (existing) {
    return NextResponse.json(
      { error: "A matching training record already exists for this student" },
      { status: 409 }
    );
  }

  const created = await prisma.trainingTaken.create({
    data: {
      email,
      trainingTitle,
      completedDate: parsedCompleted,
      expiryDate: computeExpiryDate(parsedCompleted),
    },
  });

  return NextResponse.json(created, { status: 201 });
}
