import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

// Read-only endpoint for any authenticated user (charts/reports need the
// per-product colour map and can't reach /api/admin/product-types).
export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const rows = await prisma.productType.findMany({
    orderBy: { name: "asc" },
    select: { name: true, color: true },
  });

  return NextResponse.json(rows);
}
