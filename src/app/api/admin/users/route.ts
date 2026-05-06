import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, hashPassword, requireSuperAdmin, validatePassword } from "@/lib/auth";

const VALID_ROLES = new Set(["SuperAdmin", "Admin", "User"]);

// GET: list all users, including their company assignments
export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      mfaEnabled: true,
      mustEnableMfa: true,
      lastLoginAt: true,
      lastLoginIp: true,
      createdAt: true,
      companies: { select: { companyId: true, company: { select: { id: true, name: true } } } },
    },
  });

  return NextResponse.json(
    users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      mfaEnabled: u.mfaEnabled,
      mustEnableMfa: u.mustEnableMfa,
      lastLoginAt: u.lastLoginAt,
      lastLoginIp: u.lastLoginIp,
      createdAt: u.createdAt,
      companies: u.companies.map((uc) => ({ id: uc.company.id, name: uc.company.name })),
    }))
  );
}

// POST: create a new user
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const { username, displayName, password, role, companyIds, mustEnableMfa } = body as {
    username?: string;
    displayName?: string;
    password?: string;
    role?: string;
    companyIds?: number[];
    mustEnableMfa?: boolean;
  };

  if (!username || !displayName || !password) {
    return NextResponse.json(
      { error: "Username, display name, and password are required" },
      { status: 400 }
    );
  }

  const passwordError = validatePassword(password);
  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });

  const effectiveRole = role && VALID_ROLES.has(role) ? role : "User";
  if (role && !VALID_ROLES.has(role)) {
    return NextResponse.json({ error: "Role must be SuperAdmin, Admin, or User" }, { status: 400 });
  }

  // Lowercase the username so login is case-insensitive (matches login route).
  const normalizedUsername = username.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { username: normalizedUsername } });
  if (existing) return NextResponse.json({ error: "Username already exists" }, { status: 409 });

  const ids = Array.isArray(companyIds) ? companyIds.filter((n) => Number.isInteger(n)) : [];

  // SuperAdmin sees everything; per-company assignments are ignored for that role
  const linkIds = effectiveRole === "SuperAdmin" ? [] : ids;

  if (linkIds.length > 0) {
    const found = await prisma.company.findMany({
      where: { id: { in: linkIds } },
      select: { id: true },
    });
    if (found.length !== linkIds.length) {
      return NextResponse.json({ error: "One or more companies not found" }, { status: 400 });
    }
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      username: normalizedUsername,
      displayName,
      passwordHash,
      role: effectiveRole as "SuperAdmin" | "Admin" | "User",
      mustEnableMfa: mustEnableMfa === true,
      companies: { create: linkIds.map((cid) => ({ companyId: cid })) },
    },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      mfaEnabled: true,
      mustEnableMfa: true,
      lastLoginAt: true,
      lastLoginIp: true,
      createdAt: true,
      companies: { select: { company: { select: { id: true, name: true } } } },
    },
  });

  return NextResponse.json(
    {
      ...user,
      companies: user.companies.map((c) => c.company),
    },
    { status: 201 }
  );
}
