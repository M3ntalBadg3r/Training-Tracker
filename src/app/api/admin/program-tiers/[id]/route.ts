import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

/**
 * PATCH /api/admin/program-tiers/[id]
 * Updates a tier's name / sortOrder / specialisationsRequired.
 */
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
  const tierId = parseInt(id, 10);
  if (isNaN(tierId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const existing = await prisma.programTier.findUnique({ where: { id: tierId } });
  if (!existing) return NextResponse.json({ error: "Tier not found" }, { status: 404 });

  const body = await request.json();
  const data: { name?: string; sortOrder?: number; specialisationsRequired?: number } = {};

  if (body?.name != null) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "Tier name is required" }, { status: 400 });
    if (name !== existing.name) {
      const collide = await prisma.programTier.findUnique({
        where: { programName_name: { programName: existing.programName, name } },
      });
      if (collide) {
        return NextResponse.json(
          { error: "A tier with this name already exists in this program" },
          { status: 409 }
        );
      }
    }
    data.name = name;
  }
  if (body?.sortOrder != null) {
    const sortOrder = Number(body.sortOrder);
    if (Number.isNaN(sortOrder)) return NextResponse.json({ error: "Invalid sort order" }, { status: 400 });
    data.sortOrder = sortOrder;
  }
  if (body?.specialisationsRequired != null) {
    const n = Number(body.specialisationsRequired);
    if (!n || n < 1) {
      return NextResponse.json({ error: "Specialisations required must be at least 1" }, { status: 400 });
    }
    data.specialisationsRequired = n;
  }

  const tier = await prisma.programTier.update({ where: { id: tierId }, data });
  return NextResponse.json({
    id: tier.id,
    programName: tier.programName,
    name: tier.name,
    sortOrder: tier.sortOrder,
    specialisationsRequired: tier.specialisationsRequired,
  });
}

/**
 * DELETE /api/admin/program-tiers/[id]
 * Deletes a tier; its deployment requirements (ProgramData with this tierId)
 * cascade via the FK.
 */
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
  const tierId = parseInt(id, 10);
  if (isNaN(tierId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  await prisma.programTier.delete({ where: { id: tierId } });
  return NextResponse.json({ success: true });
}
