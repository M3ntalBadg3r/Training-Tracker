import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key");

  if (key) {
    const record = await prisma.importMetadata.findUnique({ where: { key } });
    return NextResponse.json(record);
  }

  const records = await prisma.importMetadata.findMany();
  return NextResponse.json(records);
}
