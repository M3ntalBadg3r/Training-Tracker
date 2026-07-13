import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { safeDecodeParam } from "@/lib/utils";

/**
 * GET /api/admin/offerings/[offeringName]
 * Returns one offering's details: name, description, link, and selected
 * specialisation ids/names.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ offeringName: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { offeringName } = await params;
  const name = safeDecodeParam(offeringName);
  if (name === null) {
    return NextResponse.json({ error: "Invalid offering name" }, { status: 400 });
  }

  const offering = await prisma.offering.findUnique({
    where: { name },
    include: { specialisations: { include: { specialisation: { select: { id: true, name: true } } } } },
  });
  if (!offering) {
    return NextResponse.json({ error: "Offering not found" }, { status: 404 });
  }

  return NextResponse.json({
    name: offering.name,
    description: offering.description ?? null,
    link: offering.link ?? null,
    specialisations: offering.specialisations
      .map((s) => ({ id: s.specialisation.id, name: s.specialisation.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}

/**
 * PATCH /api/admin/offerings/[offeringName]
 * Updates an offering. Body may carry any subset of:
 *  - newName: rename (updates the Offering row; offering_data / offering_specialisations
 *    cascade via the FK's ON UPDATE CASCADE).
 *  - description / link.
 *  - specialisationIds: replace the selected-specialisation set. Removing a
 *    specialisation that still has requirement rows is blocked (409).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ offeringName: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { offeringName } = await params;
  const oldName = safeDecodeParam(offeringName);
  if (oldName === null) {
    return NextResponse.json({ error: "Invalid offering name" }, { status: 400 });
  }

  const existing = await prisma.offering.findUnique({ where: { name: oldName } });
  if (!existing) {
    return NextResponse.json({ error: "Offering not found" }, { status: 404 });
  }

  const body = await request.json();
  const rawNewName = typeof body?.newName === "string" ? body.newName.trim() : "";
  const wantsRename = rawNewName !== "" && rawNewName !== oldName;
  const hasDescription = typeof body?.description === "string";
  const hasLink = typeof body?.link === "string";
  const hasSpecs = Array.isArray(body?.specialisationIds);

  if (wantsRename) {
    const collide = await prisma.offering.findUnique({ where: { name: rawNewName } });
    if (collide) {
      return NextResponse.json({ error: "An offering with this name already exists" }, { status: 409 });
    }
  }

  const finalName = wantsRename ? rawNewName : oldName;

  let newSpecIds: number[] = [];
  if (hasSpecs) {
    newSpecIds = [
      ...new Set(
        (body.specialisationIds as unknown[]).map((n) => Number(n)).filter((n) => !Number.isNaN(n))
      ),
    ];
    if (newSpecIds.length > 0) {
      const found = await prisma.specialisation.count({ where: { id: { in: newSpecIds } } });
      if (found !== newSpecIds.length) {
        return NextResponse.json({ error: "One or more specialisations not found" }, { status: 404 });
      }
    }
    // Block removing a specialisation that still has requirement rows.
    const currentReqSpecs = await prisma.offeringData.findMany({
      where: { offeringName: oldName },
      select: { specialisationId: true },
      distinct: ["specialisationId"],
    });
    const removed = currentReqSpecs
      .map((r) => r.specialisationId)
      .filter((id) => !newSpecIds.includes(id));
    if (removed.length > 0) {
      return NextResponse.json(
        { error: "Remove that specialisation's requirements before deselecting it" },
        { status: 409 }
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.offering.update({
      where: { name: oldName },
      data: {
        ...(wantsRename ? { name: rawNewName } : {}),
        ...(hasDescription ? { description: body.description.trim() || null } : {}),
        ...(hasLink ? { link: body.link.trim() || null } : {}),
      },
    });
    if (hasSpecs) {
      // Replace the selected-specialisation set (offering_data rows are protected
      // above; offering_specialisations rows are safe to rebuild).
      await tx.offeringSpecialisation.deleteMany({ where: { offeringName: finalName } });
      if (newSpecIds.length > 0) {
        await tx.offeringSpecialisation.createMany({
          data: newSpecIds.map((specialisationId) => ({ offeringName: finalName, specialisationId })),
        });
      }
    }
  });

  return NextResponse.json({ success: true, name: finalName });
}

/**
 * DELETE /api/admin/offerings/[offeringName]
 * Deletes an offering and all of its requirements + specialisation links
 * (cascade via FKs).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ offeringName: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { offeringName } = await params;
  const name = safeDecodeParam(offeringName);
  if (name === null) {
    return NextResponse.json({ error: "Invalid offering name" }, { status: 400 });
  }

  await prisma.offering.deleteMany({ where: { name } });
  return NextResponse.json({ success: true });
}
