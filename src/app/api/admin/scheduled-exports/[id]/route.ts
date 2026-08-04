import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { canAccessCompany } from "@/lib/company-scope";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const numId = Number(id);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const existing = await prisma.scheduledExport.findUnique({ where: { id: numId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await canAccessCompany(auth.sub, auth.role, existing.companyId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { name, companyId, reportType, format, destination, config, enabled, frequency, time, dayOfWeek, dayOfMonth } = body;

    let nextCompanyId: number | undefined;
    if (companyId !== undefined && companyId !== null && Number(companyId) !== existing.companyId) {
      const cid = Number(companyId);
      if (!Number.isInteger(cid)) return NextResponse.json({ error: "Invalid companyId" }, { status: 400 });
      if (!(await canAccessCompany(auth.sub, auth.role, cid))) {
        return NextResponse.json({ error: "You do not have access to that company" }, { status: 403 });
      }
      nextCompanyId = cid;
    }

    const record = await prisma.scheduledExport.update({
      where: { id: numId },
      data: {
        ...(name !== undefined && { name }),
        ...(nextCompanyId !== undefined && { companyId: nextCompanyId }),
        ...(reportType !== undefined && { reportType }),
        ...(format !== undefined && { format }),
        ...(destination !== undefined && { destination }),
        ...(config !== undefined && { config }),
        ...(enabled !== undefined && { enabled }),
        ...(frequency !== undefined && { frequency }),
        ...(time !== undefined && { time }),
        ...(dayOfWeek !== undefined && { dayOfWeek: dayOfWeek === null ? null : Number(dayOfWeek) }),
        ...(dayOfMonth !== undefined && { dayOfMonth: dayOfMonth === null ? null : Number(dayOfMonth) }),
      },
    });

    return NextResponse.json(record);
  } catch {
    return NextResponse.json({ error: "Failed to update schedule" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const numId = Number(id);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const existing = await prisma.scheduledExport.findUnique({ where: { id: numId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await canAccessCompany(auth.sub, auth.role, existing.companyId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await prisma.scheduledExport.delete({ where: { id: numId } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete schedule" }, { status: 500 });
  }
}
