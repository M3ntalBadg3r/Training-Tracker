import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { TrainingType, ProductType, FunctionType } from "@prisma/client";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ title: string }> }
) {
  const { title } = await params;
  const decodedTitle = decodeURIComponent(title);

  const training = await prisma.trainingData.findUnique({
    where: { trainingTitle: decodedTitle },
  });

  if (!training) {
    return NextResponse.json({ error: "Training not found" }, { status: 404 });
  }

  return NextResponse.json(training);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ title: string }> }
) {
  const { title } = await params;
  const decodedTitle = decodeURIComponent(title);
  const body = await request.json();

  const newTitle = body.trainingTitle?.trim();

  // If trainingTitle changed, need to delete + recreate since it's the PK
  if (newTitle && newTitle !== decodedTitle) {
    const existing = await prisma.trainingData.findUnique({
      where: { trainingTitle: newTitle },
    });
    if (existing) {
      return NextResponse.json(
        { error: `Training title "${newTitle}" already exists` },
        { status: 409 }
      );
    }

    const training = await prisma.$transaction(async (tx) => {
      // Update all references in training_taken
      await tx.trainingTaken.updateMany({
        where: { trainingTitle: decodedTitle },
        data: { trainingTitle: newTitle },
      });
      const old = await tx.trainingData.findUnique({
        where: { trainingTitle: decodedTitle },
      });
      await tx.trainingData.delete({ where: { trainingTitle: decodedTitle } });
      return tx.trainingData.create({
        data: {
          trainingTitle: newTitle,
          fullTitle: body.fullTitle ?? old?.fullTitle ?? "",
          trainingType: (body.trainingType as TrainingType) ?? old?.trainingType ?? "Certification",
          productType: (body.productType as ProductType) ?? old?.productType ?? "Cortex",
          function: (body.function as FunctionType) ?? old?.function ?? "Sales",
          link: body.link !== undefined ? body.link || null : old?.link ?? null,
          certification: body.certification !== undefined ? body.certification || null : old?.certification ?? null,
        },
      });
    });

    return NextResponse.json(training);
  }

  const training = await prisma.trainingData.update({
    where: { trainingTitle: decodedTitle },
    data: {
      ...(body.fullTitle && { fullTitle: body.fullTitle }),
      ...(body.trainingType && {
        trainingType: body.trainingType as TrainingType,
      }),
      ...(body.productType && {
        productType: body.productType as ProductType,
      }),
      ...(body.function && { function: body.function as FunctionType }),
      ...(body.link !== undefined && { link: body.link || null }),
      ...(body.certification !== undefined && { certification: body.certification || null }),
    },
  });

  return NextResponse.json(training);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ title: string }> }
) {
  const { title } = await params;
  const decodedTitle = decodeURIComponent(title);

  await prisma.trainingData.delete({
    where: { trainingTitle: decodedTitle },
  });

  return NextResponse.json({ success: true });
}
