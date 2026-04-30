import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";

// GET: list all companies (SuperAdmin only)
export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const companies = await prisma.company.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: { select: { students: true } },
    },
  });

  return NextResponse.json(
    companies.map((c) => ({
      id: c.id,
      name: c.name,
      studentCount: c._count.students,
      createdAt: c.createdAt,
    }))
  );
}

// POST: create a new company (SuperAdmin only)
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (name.length > 200) return NextResponse.json({ error: "Name is too long" }, { status: 400 });

  const existing = await prisma.company.findUnique({ where: { name } });
  if (existing) return NextResponse.json({ error: "A company with that name already exists" }, { status: 409 });

  const created = await prisma.company.create({ data: { name } });
  return NextResponse.json(created, { status: 201 });
}
