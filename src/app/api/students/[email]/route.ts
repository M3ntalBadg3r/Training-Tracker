import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { isActive, formatDate, trainingTypeLabel, functionTypeLabel } from "@/lib/utils";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany, getAuthorizedCompanyIds } from "@/lib/company-scope";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { email } = await params;
  const decodedEmail = decodeURIComponent(email);

  const student = await prisma.student.findUnique({
    where: { email: decodedEmail },
    include: {
      regionData: true,
      company: { select: { id: true, name: true } },
      trainings: {
        include: { trainingData: true },
        orderBy: { completedDate: "desc" },
      },
    },
  });

  if (!student) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  // Enforce company scoping
  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  if (allowed !== null && !allowed.includes(student.companyId)) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  const dedupeMap = new Map<string, (typeof student.trainings)[number]>();
  for (const t of student.trainings) {
    const key = `${t.trainingData.fullTitle}::${t.trainingData.trainingType}`;
    const existing = dedupeMap.get(key);
    if (!existing || t.completedDate > existing.completedDate) {
      dedupeMap.set(key, t);
    }
  }

  const result = {
    email: student.email,
    fullName: student.fullName,
    theatre: student.theatre,
    country: student.country,
    region: student.regionData?.region || null,
    companyId: student.companyId,
    companyName: student.company?.name ?? null,
    trainings: Array.from(dedupeMap.values()).map((t) => ({
      id: t.id,
      fullTitle: t.trainingData.fullTitle,
      link: t.trainingData.link,
      trainingType: trainingTypeLabel(t.trainingData.trainingType),
      productType: t.trainingData.productType,
      function: functionTypeLabel(t.trainingData.function),
      completedDate: formatDate(t.completedDate),
      expiryDate: formatDate(t.expiryDate),
      active: isActive(t.expiryDate),
    })),
  };

  return NextResponse.json(result);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const { email } = await params;
  const decodedEmail = decodeURIComponent(email);
  const body = await request.json();

  // Theatre is intentionally not accepted from the client — it's derived
  // from the (possibly new) country's RegionData entry whenever country changes.
  const { fullName, country, newEmail, companyId } = body;

  if ((fullName && (typeof fullName !== "string" || fullName.length > 255)) ||
      (country && (typeof country !== "string" || country.length > 100))) {
    return NextResponse.json({ error: "Invalid field value" }, { status: 400 });
  }
  if (newEmail && (typeof newEmail !== "string" || newEmail.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail))) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
  }

  const existing = await prisma.student.findUnique({ where: { email: decodedEmail } });
  if (!existing) return NextResponse.json({ error: "Student not found" }, { status: 404 });

  // Caller must have access to the student's current company
  if (!(await canAccessCompany(auth.sub, auth.role, existing.companyId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // If reassigning to a new company, the caller must also have access to that target.
  let nextCompanyId: number | undefined;
  if (companyId !== undefined && companyId !== null && Number(companyId) !== existing.companyId) {
    const cid = Number(companyId);
    if (!Number.isInteger(cid)) return NextResponse.json({ error: "Invalid company" }, { status: 400 });
    if (!(await canAccessCompany(auth.sub, auth.role, cid))) {
      return NextResponse.json({ error: "You do not have access to that company" }, { status: 403 });
    }
    const target = await prisma.company.findUnique({ where: { id: cid } });
    if (!target) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    nextCompanyId = cid;
  }

  // If the country changed, look up the RegionData entry and derive the new
  // theatre. Reject the change when the new country isn't configured. When
  // country didn't change, leave the existing theatre alone (so post-migration
  // students with mismatched theatres aren't silently mutated).
  let nextTheatre: string | undefined;
  if (country && country !== existing.country) {
    const rd = await prisma.regionData.findUnique({ where: { country } });
    if (!rd || !rd.theatre) {
      return NextResponse.json(
        {
          error: `Country "${country}" must exist in Region Data with a theatre assigned. Ask a SuperAdmin to set it up.`,
        },
        { status: 400 }
      );
    }
    nextTheatre = rd.theatre;
  }

  if (newEmail && newEmail !== decodedEmail) {
    await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await tx.trainingTaken.updateMany({
        where: { email: decodedEmail },
        data: { email: newEmail },
      });

      await tx.student.delete({ where: { email: decodedEmail } });
      await tx.student.create({
        data: {
          email: newEmail,
          fullName: fullName || existing.fullName,
          theatre: nextTheatre ?? existing.theatre,
          country: country || existing.country,
          companyId: nextCompanyId ?? existing.companyId,
        },
      });
    });

    return NextResponse.json({ success: true, email: newEmail });
  }

  const student = await prisma.student.update({
    where: { email: decodedEmail },
    data: {
      ...(fullName && { fullName }),
      ...(country && { country }),
      ...(nextTheatre !== undefined && { theatre: nextTheatre }),
      ...(nextCompanyId !== undefined && { companyId: nextCompanyId }),
    },
  });

  return NextResponse.json(student);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const { email } = await params;
  const decodedEmail = decodeURIComponent(email);

  const existing = await prisma.student.findUnique({ where: { email: decodedEmail } });
  if (!existing) return NextResponse.json({ error: "Student not found" }, { status: 404 });
  if (!(await canAccessCompany(auth.sub, auth.role, existing.companyId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.student.delete({ where: { email: decodedEmail } });

  return NextResponse.json({ success: true });
}
