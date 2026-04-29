import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { hashPassword, validatePassword } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// GET: Check if setup is needed (0 users in DB)
export async function GET() {
  const userCount = await prisma.user.count();
  return NextResponse.json({ needsSetup: userCount === 0 });
}

// POST: Create the first admin user (only works when 0 users exist)
export async function POST(request: NextRequest) {
  // Rate limit: 5 setup attempts per 15 minutes per IP
  const ip = getClientIp(request);
  if (!checkRateLimit(`setup:${ip}`, 5, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 }
    );
  }

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

  // The first user is always a SuperAdmin so they can manage companies, users,
  // and the rest of the system.
  const user = await prisma.user.create({
    data: {
      username,
      displayName,
      passwordHash,
      role: "SuperAdmin",
    },
  });

  // Make sure a default "Unassigned" company exists so imports and student
  // creation work out of the box.
  await prisma.company.upsert({
    where: { name: "Unassigned" },
    update: {},
    create: { name: "Unassigned" },
  });

  return NextResponse.json(
    { id: user.id, username: user.username, role: user.role },
    { status: 201 }
  );
}
