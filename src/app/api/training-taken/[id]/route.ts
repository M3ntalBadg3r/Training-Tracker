import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { parseDate, computeExpiryDate } from "@/lib/utils";
import { canAccessCompany } from "@/lib/company-scope";
import { recomputeParentsForSubItem } from "@/lib/olx";
import { invalidateReportCache } from "@/lib/report-cache";

async function getRecordOrForbid(
  id: number,
  userId: number,
  role: string
): Promise<
  | { ok: true; email: string; trainingTitle: string }
  | { ok: false; status: number; error: string }
> {
  const record = await prisma.trainingTaken.findUnique({
    where: { id },
    include: { student: { select: { companyId: true } } },
  });
  if (!record) return { ok: false, status: 404, error: "Training record not found" };
  if (!(await canAccessCompany(userId, role, record.student.companyId))) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, email: record.email, trainingTitle: record.trainingTitle };
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const check = await getRecordOrForbid(numId, auth.sub, auth.role);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  await prisma.trainingTaken.delete({ where: { id: numId } });

  // If a sub-item was removed, the parent OLX may no longer be complete.
  await recomputeParentsForSubItem(check.email, check.trainingTitle);

  invalidateReportCache();
  return NextResponse.json({ success: true });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const check = await getRecordOrForbid(numId, auth.sub, auth.role);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const body = await request.json();
  const { completedDate } = body;

  if (!completedDate || typeof completedDate !== "string") {
    return NextResponse.json({ error: "completedDate is required" }, { status: 400 });
  }

  const parsedCompleted = parseDate(completedDate);
  if (!parsedCompleted) {
    return NextResponse.json({ error: "Invalid completedDate" }, { status: 400 });
  }

  const updated = await prisma.trainingTaken.update({
    where: { id: numId },
    data: {
      completedDate: parsedCompleted,
      expiryDate: computeExpiryDate(parsedCompleted),
    },
  });

  // Sub-item completion date changed → parent's "latest sub-item" date may shift.
  await recomputeParentsForSubItem(check.email, check.trainingTitle);

  invalidateReportCache();
  return NextResponse.json(updated);
}
