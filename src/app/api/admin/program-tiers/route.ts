import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

/**
 * GET /api/admin/program-tiers?programName=...
 * Lists tiers, optionally filtered to one program, ordered by sortOrder.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const programName = request.nextUrl.searchParams.get("programName") || undefined;
  const tiers = await prisma.programTier.findMany({
    where: programName ? { programName } : undefined,
    orderBy: [{ programName: "asc" }, { sortOrder: "asc" }],
  });

  return NextResponse.json(
    tiers.map((t) => ({
      id: t.id,
      programName: t.programName,
      name: t.name,
      sortOrder: t.sortOrder,
      specialisationsRequired: t.specialisationsRequired,
    }))
  );
}

/**
 * POST /api/admin/program-tiers
 * Creates a tier. Body: { programName, name, sortOrder?, specialisationsRequired? }.
 * Upserts the Program registry row so the program persists (like program-data).
 */
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const programName = typeof body?.programName === "string" ? body.programName.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!programName) return NextResponse.json({ error: "Program name is required" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "Tier name is required" }, { status: 400 });

  const specialisationsRequired = Number(body?.specialisationsRequired);
  if (!specialisationsRequired || specialisationsRequired < 1) {
    return NextResponse.json({ error: "Specialisations required must be at least 1" }, { status: 400 });
  }

  // Default sortOrder to the next slot for this program.
  let sortOrder = Number(body?.sortOrder);
  if (Number.isNaN(sortOrder)) {
    const max = await prisma.programTier.aggregate({
      where: { programName },
      _max: { sortOrder: true },
    });
    sortOrder = (max._max.sortOrder ?? 0) + 1;
  }

  const existing = await prisma.programTier.findUnique({
    where: { programName_name: { programName, name } },
  });
  if (existing) {
    return NextResponse.json({ error: "A tier with this name already exists in this program" }, { status: 409 });
  }

  // Ensure the program is registered (and marked tiered) so it persists.
  await prisma.program.upsert({
    where: { name: programName },
    create: { name: programName, isTiered: true },
    update: { isTiered: true },
  });

  const tier = await prisma.programTier.create({
    data: { programName, name, sortOrder, specialisationsRequired },
  });

  return NextResponse.json(
    {
      id: tier.id,
      programName: tier.programName,
      name: tier.name,
      sortOrder: tier.sortOrder,
      specialisationsRequired: tier.specialisationsRequired,
    },
    { status: 201 }
  );
}
