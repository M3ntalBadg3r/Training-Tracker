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
