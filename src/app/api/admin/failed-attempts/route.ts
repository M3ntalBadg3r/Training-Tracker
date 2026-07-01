import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { listFailedAttempts } from "@/lib/failed-attempts";
import { LOGIN_IP_MAX_ATTEMPTS } from "@/lib/rate-limit";
import { INVALID_KEY_LIMIT } from "@/lib/api-key";

// GET: recent failed attempts + currently-active blocks for the admin dashboards.
// `?kind=login` (for /admin/users) or `?kind=api` (for /admin/api-keys).
export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const kind = request.nextUrl.searchParams.get("kind") === "api" ? "api" : "login";
  const now = new Date();

  const attempts = await listFailedAttempts(kind);

  if (kind === "login") {
    // Accounts currently locked out, and IPs currently over the per-IP login limit.
    const [lockedUsers, loginBuckets] = await Promise.all([
      prisma.user.findMany({
        where: { lockedUntil: { gt: now } },
        select: { username: true, lockedUntil: true, failedLoginAttempts: true },
        orderBy: { lockedUntil: "desc" },
      }),
      prisma.rateLimitBucket.findMany({
        where: {
          key: { startsWith: "login:" },
          count: { gte: LOGIN_IP_MAX_ATTEMPTS },
          resetAt: { gt: now },
        },
      }),
    ]);

    return NextResponse.json({
      attempts,
      lockedUsers,
      blockedIps: loginBuckets.map((b) => ({
        ip: b.key.slice("login:".length),
        resetAt: b.resetAt,
      })),
    });
  }

  // kind === "api": IPs currently over the invalid-key limit.
  const apiBuckets = await prisma.rateLimitBucket.findMany({
    where: {
      key: { startsWith: "apikey-fail:" },
      count: { gte: INVALID_KEY_LIMIT },
      resetAt: { gt: now },
    },
  });

  return NextResponse.json({
    attempts,
    blockedIps: apiBuckets.map((b) => ({
      ip: b.key.slice("apikey-fail:".length),
      resetAt: b.resetAt,
    })),
  });
}
