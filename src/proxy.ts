import { NextRequest, NextResponse } from "next/server";
import { jwtVerify, SignJWT } from "jose";
import { verifyCronSignature } from "@/lib/cron-auth";

const COOKIE_NAME = "tt-auth";

// Session timeout defaults — kept in sync with lib/auth.ts. The idle window is
// baked into each token (idleMs claim); these are only fallbacks for legacy
// tokens minted before those claims existed.
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_SESSION_MS =
  (Number(process.env.SESSION_ABSOLUTE_HOURS) || 8) * 60 * 60 * 1000;

/**
 * Mirror of lib/auth.ts:isRequestSecure, inlined so the edge proxy doesn't
 * import the Node-only auth module. Decides whether the refreshed auth cookie
 * carries the Secure attribute.
 */
function isRequestSecure(request: NextRequest): boolean {
  const base = process.env.APP_BASE_URL?.trim();
  if (base) return base.toLowerCase().startsWith("https://");
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ??
    new URL(request.url).protocol.replace(":", "");
  return proto === "https";
}

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
  "/admin/system-settings",
  "/api/admin/system-settings",
  "/api/admin/import-aliases",
  "/admin/specialisations",
  "/api/admin/specialisations",
  "/admin/product-types",
  "/api/admin/product-types",
  "/admin/program-data",
  "/api/admin/program-data",
  "/admin/offerings",
  "/api/admin/offerings",
  "/api/admin/offering-data",
  "/admin/backup",
  "/api/admin/backup",
  "/admin/cleanup",
  "/api/admin/cleanup",
  "/admin/updates",
  "/api/admin/updates",
  "/api/admin/wipe",
  "/api/admin/security",
  "/admin/api-keys",
  "/api/admin/api-keys",
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

  // The read-only public API authenticates with an API key (not the JWT
  // cookie). Edge middleware can't do the required DB lookup, so let these
  // requests through — each route handler enforces the key via requireApiKey().
  if (pathname.startsWith("/api/public/")) {
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

  const now = Date.now();
  const idleMs =
    typeof payload.idleMs === "number" && payload.idleMs > 0
      ? payload.idleMs
      : DEFAULT_IDLE_MS;
  // Legacy tokens (pre-idle-timeout) have no sessionStart — fall back to their
  // issued-at so the absolute cap still anchors sensibly.
  const sessionStart =
    typeof payload.sessionStart === "number"
      ? payload.sessionStart
      : typeof payload.iat === "number"
        ? payload.iat * 1000
        : now;
  const absoluteDeadline = sessionStart + ABSOLUTE_SESSION_MS;

  // Absolute cap: even a continuously-active session ends here. Treat like an
  // expired token — bounce to login and clear the cookie.
  if (now >= absoluteDeadline) {
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.set(COOKIE_NAME, "", { maxAge: 0, path: "/" });
    return response;
  }

  // Slide the idle window forward for active users. Only re-sign when the token
  // is past the halfway mark of its window (keeps churn low and, crucially,
  // never disturbs legacy long-lived tokens that still have hours left).
  const expMs = typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  const remaining = expMs - now;
  let refreshedToken: string | null = null;
  if (remaining < idleMs / 2) {
    const newExpMs = Math.min(now + idleMs, absoluteDeadline);
    if (newExpMs > now) {
      // Preserve every claim; refresh only iat/exp and (re)assert the session
      // anchor + idle window.
      const { iat: _iat, exp: _exp, nbf: _nbf, ...claims } = payload;
      void _iat;
      void _exp;
      void _nbf;
      const secret = new TextEncoder().encode(process.env.JWT_SECRET);
      refreshedToken = await new SignJWT({ ...claims, sessionStart, idleMs })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(newExpMs / 1000))
        .sign(secret);
    }
  }

  const applyRefresh = (response: NextResponse): NextResponse => {
    if (refreshedToken) {
      response.cookies.set(COOKIE_NAME, refreshedToken, {
        httpOnly: true,
        secure: isRequestSecure(request),
        sameSite: "strict",
        path: "/",
        maxAge: Math.floor(idleMs / 1000),
      });
    }
    return response;
  };

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
    return applyRefresh(NextResponse.redirect(new URL("/setup-mfa", request.url)));
  }

  // SuperAdmin-only paths
  if (isSuperAdminPath(pathname) && role !== "SuperAdmin") {
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return applyRefresh(NextResponse.redirect(new URL("/dashboard", request.url)));
  }

  // Admin (or SuperAdmin) required for the rest of the admin surface
  if (isAdminPath(pathname) && !isAdminish) {
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return applyRefresh(NextResponse.redirect(new URL("/dashboard", request.url)));
  }

  return applyRefresh(NextResponse.next());
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
