import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAuthFromRequest, ABSOLUTE_SESSION_MS, DEFAULT_IDLE_MS } from "@/lib/auth";
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

  // Session timing for the client's idle-timeout manager. idleMs is baked into
  // the token; sessionExpiresAt is the absolute (hard) logout deadline.
  const idleMs = authUser.idleMs ?? DEFAULT_IDLE_MS;
  const sessionStart = authUser.sessionStart ?? Date.now();

  return NextResponse.json({
    ...user,
    dateFormat: isDateFormat(user.dateFormat) ? user.dateFormat : null,
    systemDateFormat,
    pendingMfaEnrollment: authUser.pendingMfaEnrollment === true,
    idleMs,
    sessionExpiresAt: sessionStart + ABSOLUTE_SESSION_MS,
  });
}
