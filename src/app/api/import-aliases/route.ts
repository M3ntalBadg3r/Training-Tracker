import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

// Read-only endpoint for any authenticated user (the student-import wizard
// fetches this at mount to auto-map headers; admin-only mutations live under
// /api/admin/import-aliases).
export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const rows = await prisma.importAlias.findMany({
    orderBy: [{ targetField: "asc" }, { alias: "asc" }],
    select: { targetField: true, alias: true },
  });

  return NextResponse.json(rows);
}
