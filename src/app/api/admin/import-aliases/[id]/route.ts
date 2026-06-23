import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const aliasId = parseInt(id, 10);
  if (isNaN(aliasId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const { alias } = body ?? {};
  const trimmed = typeof alias === "string" ? alias.trim() : "";
  if (!trimmed) {
    return NextResponse.json({ error: "Alias is required" }, { status: 400 });
  }

  const current = await prisma.importAlias.findUnique({ where: { id: aliasId } });
  if (!current) {
    return NextResponse.json({ error: "Alias not found" }, { status: 404 });
  }

  if (trimmed !== current.alias) {
    const duplicate = await prisma.importAlias.findFirst({
      where: {
        targetField: current.targetField,
        alias: trimmed,
        NOT: { id: aliasId },
      },
    });
    if (duplicate) {
      return NextResponse.json(
        { error: "This alias already exists for that field" },
        { status: 409 }
      );
    }
  }

  const updated = await prisma.importAlias.update({
    where: { id: aliasId },
    data: { alias: trimmed },
  });
  return NextResponse.json(updated);
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
  const aliasId = parseInt(id, 10);
  if (isNaN(aliasId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  await prisma.importAlias.delete({ where: { id: aliasId } });
  return NextResponse.json({ success: true });
}
