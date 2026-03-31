import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { isActive, formatDate, trainingTypeLabel, functionTypeLabel } from "@/lib/utils";
import { requireAuth, handleAuthError } from "@/lib/auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  const { email } = await params;
  const decodedEmail = decodeURIComponent(email);

  const student = await prisma.student.findUnique({
    where: { email: decodedEmail },
    include: {
      regionData: true,
      trainings: {
        include: { trainingData: true },
        orderBy: { completedDate: "desc" },
      },
    },
  });

  if (!student) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  // Deduplicate trainings by fullTitle + trainingType, keeping most recent
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
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const { email } = await params;
  const decodedEmail = decodeURIComponent(email);
  const body = await request.json();

  const { fullName, theatre, country, newEmail } = body;

  // If email is changing, we need to update the primary key
  if (newEmail && newEmail !== decodedEmail) {
    // Use a transaction to update email across related records
    await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      // Update training_taken records first
      await tx.trainingTaken.updateMany({
        where: { email: decodedEmail },
        data: { email: newEmail },
      });

      // Delete old student and create new one
      const oldStudent = await tx.student.findUnique({
        where: { email: decodedEmail },
      });

      if (!oldStudent) throw new Error("Student not found");

      await tx.student.delete({ where: { email: decodedEmail } });
      await tx.student.create({
        data: {
          email: newEmail,
          fullName: fullName || oldStudent.fullName,
          theatre: theatre || oldStudent.theatre,
          country: country || oldStudent.country,
        },
      });
    });

    return NextResponse.json({ success: true, email: newEmail });
  }

  const student = await prisma.student.update({
    where: { email: decodedEmail },
    data: {
      ...(fullName && { fullName }),
      ...(theatre && { theatre }),
      ...(country && { country }),
    },
  });

  return NextResponse.json(student);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const { email } = await params;
  const decodedEmail = decodeURIComponent(email);

  await prisma.student.delete({ where: { email: decodedEmail } });

  return NextResponse.json({ success: true });
}
