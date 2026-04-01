import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const students = await prisma.student.findMany({
    include: { regionData: true },
    orderBy: { fullName: "asc" },
  });

  const result = students.map((s: typeof students[number]) => ({
    email: s.email,
    fullName: s.fullName,
    theatre: s.theatre,
    country: s.country,
    region: s.regionData?.region || null,
  }));

  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const body = await request.json();
  const { email, fullName, theatre, country } = body;

  if (!email || !fullName || !theatre || !country) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  // Validate types and lengths
  if (typeof email !== "string" || typeof fullName !== "string" ||
      typeof theatre !== "string" || typeof country !== "string") {
    return NextResponse.json({ error: "Invalid field types" }, { status: 400 });
  }
  if (email.length > 255 || fullName.length > 255 ||
      theatre.length > 100 || country.length > 100) {
    return NextResponse.json({ error: "Field value too long" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
  }

  const student = await prisma.student.create({
    data: { email, fullName, theatre, country },
  });

  return NextResponse.json(student, { status: 201 });
}
