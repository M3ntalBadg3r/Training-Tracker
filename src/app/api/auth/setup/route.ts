import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { hashPassword, validatePassword } from "@/lib/auth";

// GET: Check if setup is needed (0 users in DB)
export async function GET() {
  const userCount = await prisma.user.count();
  return NextResponse.json({ needsSetup: userCount === 0 });
}

// POST: Create the first admin user (only works when 0 users exist)
export async function POST(request: NextRequest) {
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    return NextResponse.json(
      { error: "Setup already completed" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const { username, displayName, password } = body;

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

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      username,
      displayName,
      passwordHash,
      role: "Admin",
    },
  });

  return NextResponse.json(
    { id: user.id, username: user.username, role: user.role },
    { status: 201 }
  );
}
