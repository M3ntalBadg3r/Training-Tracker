import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAuthFromRequest } from "@/lib/auth";
import { getSystemDateFormat } from "@/lib/system-settings";
import { isDateFormat } from "@/lib/date-format";

export async function GET(request: NextRequest) {
  const authUser = await getAuthFromRequest(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [user, systemDateFormat] = await Promise.all([
    prisma.user.findUnique({
      where: { id: authUser.sub },
      select: {
        id: true,
        username: true,
        role: true,
        displayName: true,
        mfaEnabled: true,
        mustEnableMfa: true,
        dateFormat: true,
      },
    }),
    getSystemDateFormat(),
  ]);

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...user,
    dateFormat: isDateFormat(user.dateFormat) ? user.dateFormat : null,
    systemDateFormat,
    pendingMfaEnrollment: authUser.pendingMfaEnrollment === true,
  });
}
