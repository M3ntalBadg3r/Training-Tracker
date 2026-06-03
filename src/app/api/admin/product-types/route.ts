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
    productTypes.map((pt: { id: number; name: string; color: string | null; _count: { trainingData: number } }) => ({
      id: pt.id,
      name: pt.name,
      color: pt.color,
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

  const { name, color } = await request.json();
  if (!name || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const colorResult = normaliseColor(color);
  if (typeof colorResult === "object" && colorResult !== null && "invalid" in colorResult) {
    return NextResponse.json({ error: "Colour must be a hex value like #1a2b3c" }, { status: 400 });
  }

  const existing = await prisma.productType.findFirst({
    where: { name: { equals: name.trim(), mode: "insensitive" } },
  });
  if (existing) {
    return NextResponse.json({ error: "Product type already exists" }, { status: 409 });
  }

  const productType = await prisma.productType.create({
    data: { name: name.trim(), color: colorResult as string | null },
  });

  return NextResponse.json(productType, { status: 201 });
}
