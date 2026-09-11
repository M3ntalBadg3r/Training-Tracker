import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getAuthFromRequest,
  accountDisabledResponse,
  ABSOLUTE_SESSION_MS,
  DEFAULT_IDLE_MS,
} from "@/lib/auth";
import {
  isUserDisabled,
  isUserDeleted,
  isSessionEpochStale,
} from "@/lib/user-status";
import { getSystemDateFormat } from "@/lib/system-settings";
import { isDateFormat } from "@/lib/date-format";

export async function GET(request: NextRequest) {
  const authUser = await getAuthFromRequest(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Explicit, since this route uses `getAuthFromRequest` (it must stay reachable
  // during pending-MFA enrolment) rather than `requireAuth`. Routing it through
  // the shared helper keeps one definition of the rule.
  if (await isUserDisabled(authUser.sub)) return accountDisabledResponse();
  // A deleted account used to fall through to the `findUnique` below and get a
  // bare 404, which tells the client nothing it can act on — the auto-logout
  // watches for the header this response carries.
  if (await isUserDeleted(authUser.sub)) return accountDisabledResponse();
  if (await isSessionEpochStale(authUser.sub, authUser.sessionEpoch)) {
    return accountDisabledResponse();
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
    // Served here rather than inlined into the client bundle. `next.config.ts`
    // puts APP_VERSION in `env`, which is a build-time *text substitution* at
    // every reference — and the Sidebar referenced it, so the exact version
    // shipped inside the chunk graph of the root layout and was readable by an
    // unauthenticated visitor to /login. Behind this route it is visible only
    // to someone already signed in.
    appVersion: process.env.APP_VERSION ?? null,
  });
}
