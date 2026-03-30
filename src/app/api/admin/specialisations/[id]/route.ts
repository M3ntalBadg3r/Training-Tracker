import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const specId = parseInt(id, 10);
  if (isNaN(specId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const { name } = await request.json();
  if (!name || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const existing = await prisma.specialisation.findFirst({
    where: { name: name.trim(), NOT: { id: specId } },
  });
  if (existing) {
    return NextResponse.json({ error: "Specialisation name already exists" }, { status: 409 });
  }

  const specialisation = await prisma.specialisation.update({
    where: { id: specId },
    data: { name: name.trim() },
  });

  return NextResponse.json(specialisation);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const specId = parseInt(id, 10);
  if (isNaN(specId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const inUse = await prisma.programData.findFirst({
    where: { specialisationId: specId },
  });
  if (inUse) {
    return NextResponse.json(
      { error: "Cannot delete specialisation that is used by program data" },
      { status: 409 }
    );
  }

  await prisma.specialisation.delete({ where: { id: specId } });
  return NextResponse.json({ success: true });
}
