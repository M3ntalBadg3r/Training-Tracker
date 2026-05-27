import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireAuth } from "@/lib/auth";
import { isDateFormat } from "@/lib/date-format";

export async function PUT(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // dateFormat: null  → clear preference (inherit system)
  //            string → must be a recognised format
  const raw = body.dateFormat;
  let dateFormat: string | null;
  if (raw === null || raw === "") {
    dateFormat = null;
  } else if (isDateFormat(raw)) {
    dateFormat = raw;
  } else {
    return NextResponse.json({ error: "Invalid dateFormat" }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: auth.sub },
    data: { dateFormat },
  });

  return NextResponse.json({ dateFormat });
}
