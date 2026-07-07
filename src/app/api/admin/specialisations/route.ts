import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const specialisations = await prisma.specialisation.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { programData: true } } },
  });

  return NextResponse.json(
    specialisations.map((s) => ({
      id: s.id,
      name: s.name,
      usageCount: s._count.programData,
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

  const existing = await prisma.specialisation.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return NextResponse.json({ error: "Specialisation already exists" }, { status: 409 });
  }

  const specialisation = await prisma.specialisation.create({
    data: { name: name.trim() },
  });

  return NextResponse.json(specialisation, { status: 201 });
}
