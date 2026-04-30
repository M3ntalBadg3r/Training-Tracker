import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";

const VALID_ROLES = new Set(["SuperAdmin", "Admin", "User"]);

// PUT: update display name, role, and (optionally) company assignments
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
  const userId = parseInt(id, 10);
  if (isNaN(userId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const body = await request.json();
  const { displayName, role, companyIds } = body as {
    displayName?: string;
    role?: string;
    companyIds?: number[] | null;
  };

  if (role && !VALID_ROLES.has(role)) {
    return NextResponse.json({ error: "Role must be SuperAdmin, Admin, or User" }, { status: 400 });
  }

  // Prevent demoting the last SuperAdmin (was previously "Admin", now SuperAdmin)
  if (role && role !== "SuperAdmin") {
    const current = await prisma.user.findUnique({ where: { id: userId } });
    if (current?.role === "SuperAdmin") {
      const superCount = await prisma.user.count({ where: { role: "SuperAdmin" } });
      if (superCount <= 1) {
        return NextResponse.json(
          { error: "Cannot demote the last SuperAdmin" },
          { status: 400 }
        );
      }
    }
  }

  const effectiveRole = role ?? (await prisma.user.findUnique({ where: { id: userId }, select: { role: true } }))?.role;

  // Replace company assignments if the caller provided an array.
  const shouldReplaceCompanies = Array.isArray(companyIds);
  const ids = shouldReplaceCompanies
    ? (companyIds as number[]).filter((n) => Number.isInteger(n))
    : [];

  // SuperAdmin doesn't get per-company links — clear them on promotion.
  const newLinks = effectiveRole === "SuperAdmin" ? [] : ids;

  if (shouldReplaceCompanies && newLinks.length > 0) {
    const found = await prisma.company.findMany({
      where: { id: { in: newLinks } },
      select: { id: true },
    });
    if (found.length !== newLinks.length) {
      return NextResponse.json({ error: "One or more companies not found" }, { status: 400 });
    }
  }

  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        ...(displayName && { displayName }),
        ...(role && { role: role as "SuperAdmin" | "Admin" | "User" }),
      },
    });

    if (shouldReplaceCompanies || effectiveRole === "SuperAdmin") {
      await tx.userCompany.deleteMany({ where: { userId } });
      if (newLinks.length > 0) {
        await tx.userCompany.createMany({
          data: newLinks.map((cid) => ({ userId, companyId: cid })),
          skipDuplicates: true,
        });
      }
    }

    return updated;
  });

  const withCompanies = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      mfaEnabled: true,
      createdAt: true,
      companies: { select: { company: { select: { id: true, name: true } } } },
    },
  });

  return NextResponse.json({
    ...withCompanies,
    companies: withCompanies?.companies.map((c) => c.company) ?? [],
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let authUser;
  try {
    authUser = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const userId = parseInt(id, 10);
  if (isNaN(userId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  if (userId === authUser.sub) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  const targetUser = await prisma.user.findUnique({ where: { id: userId } });
  if (targetUser?.role === "SuperAdmin") {
    const superCount = await prisma.user.count({ where: { role: "SuperAdmin" } });
    if (superCount <= 1) {
      return NextResponse.json({ error: "Cannot delete the last SuperAdmin" }, { status: 400 });
    }
  }

  await prisma.user.delete({ where: { id: userId } });
  return NextResponse.json({ success: true });
}
