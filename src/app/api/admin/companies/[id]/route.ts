import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";

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
  const companyId = Number(id);
  if (!Number.isInteger(companyId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

  const conflict = await prisma.company.findFirst({
    where: { name, NOT: { id: companyId } },
  });
  if (conflict) return NextResponse.json({ error: "A company with that name already exists" }, { status: 409 });

  const updated = await prisma.company.update({ where: { id: companyId }, data: { name } });
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
  const companyId = Number(id);
  if (!Number.isInteger(companyId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const studentCount = await prisma.student.count({ where: { companyId } });
  if (studentCount > 0) {
    return NextResponse.json(
      { error: `Cannot delete: ${studentCount} student(s) are still assigned to this company. Reassign them first.` },
      { status: 400 }
    );
  }

  const exportCount = await prisma.scheduledExport.count({ where: { companyId } });
  if (exportCount > 0) {
    return NextResponse.json(
      { error: `Cannot delete: ${exportCount} scheduled export(s) target this company.` },
      { status: 400 }
    );
  }

  await prisma.company.delete({ where: { id: companyId } });
  return NextResponse.json({ success: true });
}
