import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function normaliseColor(input: unknown): string | null | { invalid: true } {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input !== "string") return { invalid: true };
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!HEX_COLOR_RE.test(trimmed)) return { invalid: true };
  return trimmed.toLowerCase();
}

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

  const body = await request.json();
  const { name } = body;
  if (!name || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const existing = await prisma.productType.findFirst({
    where: { name: { equals: name.trim(), mode: "insensitive" }, NOT: { id: productTypeId } },
  });
  if (existing) {
    return NextResponse.json({ error: "Product type name already exists" }, { status: 409 });
  }

  // color is optional in the payload — only update it when the key is present
  // so a name-only PUT doesn't accidentally clear an existing colour.
  const data: { name: string; color?: string | null } = { name: name.trim() };
  if (Object.prototype.hasOwnProperty.call(body, "color")) {
    const colorResult = normaliseColor(body.color);
    if (typeof colorResult === "object" && colorResult !== null && "invalid" in colorResult) {
      return NextResponse.json({ error: "Colour must be a hex value like #1a2b3c" }, { status: 400 });
    }
    data.color = colorResult as string | null;
  }

  const productType = await prisma.productType.update({
    where: { id: productTypeId },
    data,
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
