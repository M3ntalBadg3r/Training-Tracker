import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError, hashPassword, validatePassword } from "@/lib/auth";

// GET: List all users
export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
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
      createdAt: true,
    },
  });

  return NextResponse.json(users);
}

// POST: Create a new user
export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const { username, displayName, password, role } = body;

  if (!username || !displayName || !password) {
    return NextResponse.json(
      { error: "Username, display name, and password are required" },
      { status: 400 }
    );
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  if (role && !["Admin", "User"].includes(role)) {
    return NextResponse.json(
      { error: "Role must be Admin or User" },
      { status: 400 }
    );
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return NextResponse.json(
      { error: "Username already exists" },
      { status: 409 }
    );
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      username,
      displayName,
      passwordHash,
      role: role || "User",
    },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      mfaEnabled: true,
      createdAt: true,
    },
  });

  return NextResponse.json(user, { status: 201 });
}
