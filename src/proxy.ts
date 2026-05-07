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
//
// Note: only **page** routes for catalogs (training-data, region-data) live
// here. The /api/training-data and /api/region-data endpoints expose read
// operations that scoped Users and Admins still need (the Training page,
// student detail page, etc.). Mutation handlers in those subtrees protect
// themselves via `requireSuperAdmin` instead.
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

// Routes the user is allowed to reach while the JWT carries the
// `pendingMfaEnrollment` claim (set by the login route when an admin has
// flagged the user with `mustEnableMfa`). Everything else is blocked until the
// user completes MFA enrolment via /setup-mfa.
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

// --- CSP nonce ---------------------------------------------------------
//
// Generated per request and propagated two ways:
//   1) as the `x-nonce` request header so Next.js stamps it onto its own
//      hydration <script> tags automatically;
//   2) as the response-side `Content-Security-Policy` header that whitelists
//      `'nonce-XXX'` plus `'strict-dynamic'`, so further scripts loaded by
//      the nonce'd hydration entry point inherit trust without needing
//      'unsafe-inline'.
//
// Edge runtime — Web Crypto only (no node:crypto).
function generateNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  // base64 encode
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  // btoa is available in Edge runtime
  return btoa(bin);
}

function buildCsp(nonce: string): string {
  // 'strict-dynamic' lets nonce'd entry scripts pull in further bundles
  // without needing 'self'/'unsafe-inline'. Style-src keeps 'unsafe-inline'
  // because Tailwind v4 + Recharts emit inline styles at runtime.
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

// Wrap NextResponse.next() so every passthrough carries the nonce on
// request (for Next to consume) and the CSP on response.
function passThrough(request: NextRequest, nonce: string, csp: string): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // Allow static assets — no CSP needed (images/css don't execute scripts).
  if (isStaticAsset(pathname)) {
    return NextResponse.next();
  }

  // Allow public paths (login, setup, and their API routes)
  if (isPublicPath(pathname)) {
    return passThrough(request, nonce, csp);
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
      return passThrough(request, nonce, csp);
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

  // Force users with mustEnableMfa to complete MFA enrolment before reaching
  // any other route. This is the server-side enforcement of the admin-set
  // "Require MFA at next login" flag — a client-side redirect would be
  // bypassable by calling APIs directly.
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

  return passThrough(request, nonce, csp);
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
