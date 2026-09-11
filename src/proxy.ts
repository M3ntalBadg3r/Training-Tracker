import { NextRequest, NextResponse } from "next/server";
import { jwtVerify, SignJWT } from "jose";
import { verifyCronRequest } from "@/lib/cron-auth";

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
  // White-label logo/favicon. The login and setup pages render these before
  // anyone has authenticated. Note this does NOT match "/api/admin/branding"
  // (the write side) — isPublicPath requires an exact or "/"-delimited match.
  "/api/branding",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

/**
 * The edge's copy of the JWT secret, with the same minimum-length guard
 * `lib/auth.ts` applies. Without it, an unset JWT_SECRET would be encoded here
 * as the literal string "undefined" — a 9-byte key — while the Node runtime
 * refused to start, so the two halves of the app would disagree about what a
 * valid token is.
 */
function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set and at least 32 characters");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Routes whose handler issues the auth cookie itself, so the proxy must not
 * also slide it.
 *
 * Both sides write the same cookie name/path, so if the proxy's refresh lands
 * on the same response the browser gets two Set-Cookie headers for `tt-auth`
 * and whichever is processed last wins — which is not ours to decide. The
 * handler is authoritative on these paths: change-password re-issues with a
 * bumped session epoch, mfa/verify clears the pending-enrolment claim, and
 * logout clears the cookie outright. A proxy refresh could resurrect any of
 * those with the pre-change claims.
 *
 * The window is narrow (the proxy only slides past the halfway mark of the idle
 * window), which is exactly what would make it an intermittent bug.
 */
const COOKIE_AUTHORITATIVE_PATHS = [
  "/api/auth/change-password",
  "/api/auth/mfa/verify",
  "/api/auth/logout",
];

/**
 * The same rule for routes whose path carries a dynamic segment and therefore
 * cannot be matched literally against the list above.
 *
 * `PUT /api/admin/users/<id>` bumps the target's session epoch on a role or
 * enrolment change, and re-issues the caller's own cookie when they are editing
 * their own row — so it is cookie-authoritative for exactly the same reason
 * change-password is.
 *
 * The prefix also covers that user's `reset-password` and `PATCH` siblings,
 * which do not issue a cookie. Suppressing the slide there costs only an idle
 * window that is not extended by these particular requests, which is a cheaper
 * mistake than the alternative.
 */
const COOKIE_AUTHORITATIVE_PREFIXES = ["/api/admin/users/"];

function issuesOwnAuthCookie(pathname: string): boolean {
  return (
    COOKIE_AUTHORITATIVE_PATHS.includes(pathname) ||
    COOKIE_AUTHORITATIVE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function isStaticAsset(pathname: string): boolean {
  // API routes are never static assets. This matters because the check below
  // is a *suffix* match and this function short-circuits the whole auth chain:
  // without this line, any API route reachable at a URL ending in one of these
  // extensions would skip authentication entirely.
  if (pathname.startsWith("/api/")) return false;
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
  "/api/admin/branding",
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

  // Allow cron-triggered endpoints with a valid HMAC signature.
  //
  // Every endpoint whose handler accepts cron auth must appear here, or the
  // proxy rejects the request before the handler ever sees it and the job fails
  // with a 401 that looks like a credentials problem. `credentials/check` was
  // missing from this list, so the daily credential health check never ran.
  //
  // This is only a "let it through" gate: the signature is re-checked in the
  // handler via authorizeCronRequest, which additionally enforces single use of
  // the nonce. The replay guard cannot live here because it needs the database
  // and the proxy has no access to it.
  const isCronRequest =
    (pathname === "/api/admin/backup/save" &&
      request.headers.get("x-auto-backup") === "true") ||
    (pathname === "/api/admin/scheduled-exports/execute" &&
      request.headers.get("x-auto-export") === "true") ||
    (pathname === "/api/admin/scheduled-exports/credentials/check" &&
      request.headers.get("x-auto-credential-check") === "true");

  if (isCronRequest) {
    if (verifyCronRequest(request).ok) {
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
    const secret = getJwtSecret();
    // Pin the algorithm: never let the token's own header choose how it is
    // verified.
    const result = await jwtVerify(token, secret, { algorithms: ["HS256"] });
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
  if (remaining < idleMs / 2 && !issuesOwnAuthCookie(pathname)) {
    const newExpMs = Math.min(now + idleMs, absoluteDeadline);
    if (newExpMs > now) {
      // Preserve every claim; refresh only iat/exp and (re)assert the session
      // anchor + idle window.
      const { iat: _iat, exp: _exp, nbf: _nbf, ...claims } = payload;
      void _iat;
      void _exp;
      void _nbf;
      const secret = getJwtSecret();
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
        // Lax (not Strict) — matches setAuthCookie so the slid cookie survives
        // top-level reloads on iOS Safari. See lib/auth.ts:setAuthCookie.
        sameSite: "lax",
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
