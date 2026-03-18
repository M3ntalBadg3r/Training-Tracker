import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
  const students = await prisma.student.findMany({
    include: { regionData: true },
    orderBy: { fullName: "asc" },
  });

  const result = students.map((s) => ({
    email: s.email,
    fullName: s.fullName,
    theatre: s.theatre,
    country: s.country,
    region: s.regionData?.region || null,
  }));

  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { email, fullName, theatre, country } = body;

  if (!email || !fullName || !theatre || !country) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  const student = await prisma.student.create({
    data: { email, fullName, theatre, country },
  });

  return NextResponse.json(student, { status: 201 });
}
