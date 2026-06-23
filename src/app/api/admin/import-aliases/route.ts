import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { isImportTargetFieldKey } from "@/lib/import-target-fields";

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const rows = await prisma.importAlias.findMany({
    orderBy: [{ targetField: "asc" }, { alias: "asc" }],
  });
  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json().catch(() => ({}));
  const { targetField, alias } = body ?? {};

  if (!isImportTargetFieldKey(targetField)) {
    return NextResponse.json({ error: "Invalid target field" }, { status: 400 });
  }

  const trimmed = typeof alias === "string" ? alias.trim() : "";
  if (!trimmed) {
    return NextResponse.json({ error: "Alias is required" }, { status: 400 });
  }

  const existing = await prisma.importAlias.findFirst({
    where: { targetField, alias: trimmed },
  });
  if (existing) {
    return NextResponse.json(
      { error: "This alias already exists for that field" },
      { status: 409 }
    );
  }

  const created = await prisma.importAlias.create({
    data: { targetField, alias: trimmed },
  });
  return NextResponse.json(created, { status: 201 });
}
