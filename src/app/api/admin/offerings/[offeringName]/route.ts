import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError, type TokenPayload } from "@/lib/auth";
import { canAccessCompany } from "@/lib/company-scope";
import { safeDecodeParam } from "@/lib/utils";

/**
 * Offering names are unique per company, so the admin editor addresses an
 * offering by name plus a required `?companyId=`. Resolve that pair to a single
 * offering the caller can access, or return the appropriate error response.
 */
async function resolveOffering(
  request: NextRequest,
  offeringNameParam: string,
  auth: TokenPayload
): Promise<
  | { ok: true; offering: { id: number; companyId: number; name: string; description: string | null; link: string | null } }
  | { ok: false; response: NextResponse }
> {
  const name = safeDecodeParam(offeringNameParam);
  if (name === null) {
    return { ok: false, response: NextResponse.json({ error: "Invalid offering name" }, { status: 400 }) };
  }
  const companyIdRaw = request.nextUrl.searchParams.get("companyId");
  const companyId = companyIdRaw == null ? NaN : Number(companyIdRaw);
  if (Number.isNaN(companyId)) {
    return { ok: false, response: NextResponse.json({ error: "A company is required" }, { status: 400 }) };
  }
  if (!(await canAccessCompany(auth.sub, auth.role, companyId))) {
    return { ok: false, response: NextResponse.json({ error: "You do not have access to that company" }, { status: 403 }) };
  }
  const offering = await prisma.offering.findUnique({ where: { companyId_name: { companyId, name } } });
  if (!offering) {
    return { ok: false, response: NextResponse.json({ error: "Offering not found" }, { status: 404 }) };
  }
  return { ok: true, offering };
}

/**
 * GET /api/admin/offerings/[offeringName]?companyId=
 * Returns one offering's details: name, description, link, and selected
 * specialisation ids/names.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ offeringName: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { offeringName } = await params;
  const resolved = await resolveOffering(request, offeringName, auth);
  if (!resolved.ok) return resolved.response;

  const offering = await prisma.offering.findUnique({
    where: { id: resolved.offering.id },
    include: { specialisations: { include: { specialisation: { select: { id: true, name: true } } } } },
  });
  if (!offering) {
    return NextResponse.json({ error: "Offering not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: offering.id,
    companyId: offering.companyId,
    name: offering.name,
    description: offering.description ?? null,
    link: offering.link ?? null,
    specialisations: offering.specialisations
      .map((s) => ({ id: s.specialisation.id, name: s.specialisation.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}

/**
 * PATCH /api/admin/offerings/[offeringName]?companyId=
 * Updates an offering. Body may carry any subset of:
 *  - newName: rename (collision checked within the same company).
 *  - description / link.
 *  - specialisationIds: replace the selected-specialisation set. Removing a
 *    specialisation that still has requirement rows is blocked (409).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ offeringName: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { offeringName } = await params;
  const resolved = await resolveOffering(request, offeringName, auth);
  if (!resolved.ok) return resolved.response;
  const existing = resolved.offering;

  const body = await request.json();
  const rawNewName = typeof body?.newName === "string" ? body.newName.trim() : "";
  const wantsRename = rawNewName !== "" && rawNewName !== existing.name;
  const hasDescription = typeof body?.description === "string";
  const hasLink = typeof body?.link === "string";
  const hasSpecs = Array.isArray(body?.specialisationIds);

  if (wantsRename) {
    const collide = await prisma.offering.findUnique({
      where: { companyId_name: { companyId: existing.companyId, name: rawNewName } },
    });
    if (collide) {
      return NextResponse.json(
        { error: "An offering with this name already exists for this company" },
        { status: 409 }
      );
    }
  }

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
      where: { offeringId: existing.id },
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
      where: { id: existing.id },
      data: {
        ...(wantsRename ? { name: rawNewName } : {}),
        ...(hasDescription ? { description: body.description.trim() || null } : {}),
        ...(hasLink ? { link: body.link.trim() || null } : {}),
      },
    });
    if (hasSpecs) {
      // Replace the selected-specialisation set (offering_data rows are protected
      // above; offering_specialisations rows are safe to rebuild).
      await tx.offeringSpecialisation.deleteMany({ where: { offeringId: existing.id } });
      if (newSpecIds.length > 0) {
        await tx.offeringSpecialisation.createMany({
          data: newSpecIds.map((specialisationId) => ({ offeringId: existing.id, specialisationId })),
        });
      }
    }
  });

  const finalName = wantsRename ? rawNewName : existing.name;
  return NextResponse.json({ success: true, name: finalName });
}

/**
 * DELETE /api/admin/offerings/[offeringName]?companyId=
 * Deletes an offering and all of its requirements + specialisation links
 * (cascade via FKs).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ offeringName: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { offeringName } = await params;
  const resolved = await resolveOffering(request, offeringName, auth);
  if (!resolved.ok) return resolved.response;

  await prisma.offering.delete({ where: { id: resolved.offering.id } });
  return NextResponse.json({ success: true });
}
