import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

// Lightweight read-only feed for the student add/edit forms. Available to any
// authenticated user (not just SuperAdmin) so scoped Admins/Users can pick a
// country when creating a student. Region data is global, not company-scoped.
export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const rows = await prisma.regionData.findMany({
    orderBy: { country: "asc" },
    select: { country: true, region: true, theatre: true },
  });

  return NextResponse.json(rows);
}
