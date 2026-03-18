import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isActive, formatDate, trainingTypeLabel, functionTypeLabel } from "@/lib/utils";

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

  const result = {
    email: student.email,
    fullName: student.fullName,
    theatre: student.theatre,
    country: student.country,
    region: student.regionData?.region || null,
    trainings: student.trainings.map((t) => ({
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
  const { email } = await params;
  const decodedEmail = decodeURIComponent(email);
  const body = await request.json();

  const { fullName, theatre, country, newEmail } = body;

  // If email is changing, we need to update the primary key
  if (newEmail && newEmail !== decodedEmail) {
    // Use a transaction to update email across related records
    await prisma.$transaction(async (tx) => {
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
  _request: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  const { email } = await params;
  const decodedEmail = decodeURIComponent(email);

  await prisma.student.delete({ where: { email: decodedEmail } });

  return NextResponse.json({ success: true });
}
