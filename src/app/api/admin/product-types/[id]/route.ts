import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const productTypeId = parseInt(id, 10);
  if (isNaN(productTypeId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const { name } = await request.json();
  if (!name || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const existing = await prisma.productType.findFirst({
    where: { name: { equals: name.trim(), mode: "insensitive" }, NOT: { id: productTypeId } },
  });
  if (existing) {
    return NextResponse.json({ error: "Product type name already exists" }, { status: 409 });
  }

  const productType = await prisma.productType.update({
    where: { id: productTypeId },
    data: { name: name.trim() },
  });

  return NextResponse.json(productType);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const productTypeId = parseInt(id, 10);
  if (isNaN(productTypeId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const inUse = await prisma.trainingData.findFirst({
    where: { productTypeId },
  });
  if (inUse) {
    return NextResponse.json(
      { error: "Cannot delete product type that is used by training data" },
      { status: 409 }
    );
  }

  await prisma.productType.delete({ where: { id: productTypeId } });
  return NextResponse.json({ success: true });
}
