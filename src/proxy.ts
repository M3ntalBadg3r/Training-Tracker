import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { verifyCronSignature } from "@/lib/cron-auth";

const COOKIE_NAME = "tt-auth";

const PUBLIC_PATHS = [
  "/login",
  "/setup",
  "/api/auth/login",
  "/api/auth/setup",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

function isStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".jpg")
  );
}

function isAdminPath(pathname: string): boolean {
  return pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
}

// SuperAdmin-only routes — these handle system-wide management (users,
// companies, training/region catalogs, backups, cleanup, updates) and are
// not safe to expose to a per-company Admin.
const SUPER_ADMIN_PREFIXES = [
  "/admin/users",
  "/api/admin/users",
  "/admin/companies",
  "/api/admin/companies",
  "/admin/region-data",
  "/admin/training-data",
  "/api/admin/specialisations",
  "/admin/program-data",
  "/api/admin/program-data",
  "/admin/backup",
  "/api/admin/backup",
  "/admin/cleanup",
  "/api/admin/cleanup",
  "/admin/updates",
  "/api/admin/updates",
  "/api/admin/wipe",
  "/api/admin/security",
];

function isSuperAdminPath(pathname: string): boolean {
  return SUPER_ADMIN_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

const MFA_ENROLLMENT_ALLOWLIST = [
  "/setup-mfa",
  "/api/auth/mfa/setup",
  "/api/auth/mfa/verify",
  "/api/auth/me",
  "/api/auth/logout",
];

function isMfaEnrollmentAllowed(pathname: string): boolean {
  return MFA_ENROLLMENT_ALLOWLIST.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow static assets
  if (isStaticAsset(pathname)) {
    return NextResponse.next();
  }

  // Allow public paths (login, setup, and their API routes)
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Allow cron-triggered endpoints with valid HMAC signature
  const isCronRequest =
    (pathname === "/api/admin/backup/save" &&
      request.headers.get("x-auto-backup") === "true") ||
    (pathname === "/api/admin/scheduled-exports/execute" &&
      request.headers.get("x-auto-export") === "true");

  if (isCronRequest) {
    const signature = request.headers.get("x-cron-signature");
    if (verifyCronSignature(signature)) {
      return NextResponse.next();
    }
    // Fall through to normal JWT auth if signature is invalid
  }

  // Verify JWT token
  const token = request.cookies.get(COOKIE_NAME)?.value;

  if (!token) {
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  let payload;
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const result = await jwtVerify(token, secret);
    payload = result.payload;
  } catch {
    // Invalid or expired token
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.set(COOKIE_NAME, "", { maxAge: 0, path: "/" });
    return response;
  }

  const role = String(payload.role ?? "");
  const isAdminish = role === "Admin" || role === "SuperAdmin";
  const pendingMfaEnrollment = payload.pendingMfaEnrollment === true;

  if (pendingMfaEnrollment && !isMfaEnrollmentAllowed(pathname)) {
    if (isApiRoute(pathname)) {
      return NextResponse.json(
        { error: "MFA enrollment required" },
        { status: 403 }
      );
    }
    return NextResponse.redirect(new URL("/setup-mfa", request.url));
  }

  // SuperAdmin-only paths
  if (isSuperAdminPath(pathname) && role !== "SuperAdmin") {
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Admin (or SuperAdmin) required for the rest of the admin surface
  if (isAdminPath(pathname) && !isAdminish) {
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
