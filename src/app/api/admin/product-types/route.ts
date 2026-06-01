import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const productTypes = await prisma.productType.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { trainingData: true } } },
  });

  return NextResponse.json(
    productTypes.map((pt: { id: number; name: string; _count: { trainingData: number } }) => ({
      id: pt.id,
      name: pt.name,
      trainingCount: pt._count.trainingData,
    }))
  );
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { name } = await request.json();
  if (!name || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const existing = await prisma.productType.findFirst({
    where: { name: { equals: name.trim(), mode: "insensitive" } },
  });
  if (existing) {
    return NextResponse.json({ error: "Product type already exists" }, { status: 409 });
  }

  const productType = await prisma.productType.create({
    data: { name: name.trim() },
  });

  return NextResponse.json(productType, { status: 201 });
}
