import { NextRequest, NextResponse } from "next/server";
import { jwtVerify, SignJWT } from "jose";
import { verifyCronRequest } from "@/lib/cron-auth";
import { SUPER_ADMIN_ROLE, isAdminish } from "@/lib/roles";
import { buildCsp, generateNonce, resolveCspMode, type CspMode } from "@/lib/csp";

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

// ---------------------------------------------------------------------------
// Content-Security-Policy
// ---------------------------------------------------------------------------
//
// The policy is built here rather than in `next.config.ts` because the strict
// variant carries a per-request nonce, and `next.config.ts` runs once at build
// time. `next.config.ts` covers the static-asset paths the `matcher` at the
// bottom of this file excludes, from the same `lib/csp.ts` builder and from the
// same `STATIC_ASSET_PREFIXES` list the matcher is written from.
//
// **Exactly one `Content-Security-Policy` response header per path, and never
// zero.** Both failures are silent. Two headers do not combine, they intersect:
// a browser enforces both, so the effective policy is the narrowest of the pair
// and a page breaks in a way neither header explains on its own. Zero headers
// looks like nothing at all — the page works, and the protection is simply
// absent. The CSP key was removed from `next.config.ts`'s catch-all `/(.*)`
// entry when the policy moved here, so the two sources have to partition the
// path space exactly between them; see `STATIC_ASSET_PREFIXES` for how, and for
// the gap the first version of this left behind.
//
// In `report-only` mode the single header goes out under the report-only name
// and there is no enforced header at all — not one of each. See the note on
// `responseCsp` below for why that is forced rather than chosen.

const CSP_HEADER = "content-security-policy";
const CSP_REPORT_ONLY_HEADER = "content-security-policy-report-only";
const NONCE_HEADER = "x-nonce";

/**
 * Is this request for an HTML document, as opposed to an API call, an RSC
 * payload, or a subresource?
 *
 * Only a document can use a nonce, so only a document gets one minted. The
 * alternative — a nonce on every response — puts a per-request value into
 * headers on responses that are allowed to be cached, and widens the blast
 * radius of any bug in the nonce path to the entire API surface.
 *
 * `sec-fetch-dest` is the modern answer and every current browser sends it on
 * navigations. When it is absent (a much older browser, or a command-line
 * client) fall back to the `Accept` header. Note the consequence for
 * hand-testing: curl sends a wildcard `Accept` and no `sec-fetch-dest`, so a
 * bare curl is NOT classified as a document and will see no nonce. Add
 * `-H 'Accept: text/html'` when checking this by hand, or you will conclude the
 * nonce is broken when it is working.
 */
function isDocumentRequest(request: NextRequest): boolean {
  const dest = request.headers.get("sec-fetch-dest");
  // When the browser tells us what this is for, believe it and nothing else —
  // an RSC fetch sends `sec-fetch-dest: empty` with a permissive Accept.
  if (dest) return dest === "document";
  const accept = request.headers.get("accept");
  if (accept === null) return true;
  return accept.includes("text/html");
}

interface CspContext {
  mode: CspMode;
  nonce: string | null;
  /** Request headers to forward, with the policy headers under our control. */
  requestHeaders: Headers;
  /** Enforced `Content-Security-Policy` response header, or null in report-only mode. */
  responseCsp: string | null;
  /** Value for the report-only response header, or null when not in that mode. */
  responseReportOnlyCsp: string | null;
}

function createCspContext(request: NextRequest): CspContext {
  const mode = resolveCspMode(process.env.CSP_MODE);
  const isDev = process.env.NODE_ENV !== "production";
  const strict = mode !== "legacy";
  const nonce = strict && isDocumentRequest(request) ? generateNonce() : null;

  const requestHeaders = new Headers(request.headers);

  // Next reads the *forwarded request* `Content-Security-Policy` header, pulls
  // the `'nonce-…'` source expression out of its `script-src`, and hands it to
  // React's renderer — which is what stamps `nonce="…"` onto the bootstrap
  // <script> tags. That is the only mechanism; `x-nonce` exists purely so our
  // own code can read the value back (the OAuth callback page does).
  //
  // Which means a *client* can send that header and choose the nonce Next
  // stamps. Harmless while `'unsafe-inline'` is in force and a hole the moment
  // it is not, so these three are cleared unconditionally — in every mode, on
  // every path — and only then re-set from values we generated. Use `set`,
  // never `append`: appending would leave the caller's value in place alongside
  // ours, and Next takes the first `script-src` it finds.
  requestHeaders.delete(CSP_HEADER);
  requestHeaders.delete(CSP_REPORT_ONLY_HEADER);
  requestHeaders.delete(NONCE_HEADER);

  const legacyCsp = buildCsp({ nonce: null, strict: false, isDev });
  const strictCsp = strict ? buildCsp({ nonce, strict: true, isDev }) : null;

  if (nonce && strictCsp) {
    // The forwarded REQUEST header always carries the *strict* policy, under
    // the plain name, in both strict modes. These headers travel inward only;
    // the browser never sees them. Their single job is to tell Next's renderer
    // which nonce to stamp, and it finds that by reading `script-src` out of
    // this header — so it must be the policy that actually contains the nonce.
    //
    // The plain name is used rather than the report-only one even in
    // report-only mode, where the response goes out under the report-only name
    // only. The two names are decoupled on purpose: see the note on
    // `responseCsp` below for why the request side cannot follow the response
    // side here.
    requestHeaders.set(CSP_HEADER, strictCsp);
    requestHeaders.set(NONCE_HEADER, nonce);
  }

  // What the browser is sent.
  //
  // `report-only` sends ONLY the report-only header — it does not keep the
  // legacy policy enforced alongside it, and that is forced rather than chosen.
  // Next takes the nonce from `req.headers["content-security-policy"]`, and the
  // Node side copies every middleware *response* header over `req.headers`
  // before the render (`resolve-routes.js`: `req.headers[key] = value`). So an
  // enforced response header always wins over the one forwarded above. Keeping
  // the legacy policy enforced during a trial would therefore hand the renderer
  // a policy with no nonce in it, nothing would be stamped, and every script
  // Next emits would report a violation — a report full of noise about the
  // framework and silent about the app, which is the one result that makes the
  // mode worthless. Putting the nonce into the legacy policy instead does not
  // work either: a policy that contains a nonce makes browsers ignore
  // `'unsafe-inline'`, so the "report-only" trial would quietly be enforcing.
  //
  // The cost is real and belongs in the operator docs: while this mode is on,
  // the enforced policy is suspended, so `frame-ancestors`, `object-src` and
  // the rest stop being enforced. It is a short diagnostic window — the mode to
  // turn on to find out *which* script broke — not a resting state.
  const isReportOnly = mode === "report-only";
  return {
    mode,
    nonce,
    requestHeaders,
    responseCsp: isReportOnly ? null : mode === "enforce" && strictCsp ? strictCsp : legacyCsp,
    responseReportOnlyCsp: isReportOnly ? strictCsp : null,
  };
}

/**
 * The single pass-through. Every pass-through branch below goes through here so
 * that no branch can forget to forward the policy headers.
 *
 * This matters more than it looks: `route()` returns from five different
 * pass-through points, and the one that covers `/login` and `/setup` is the
 * *early* `isPublicPath` return. Threading the nonce only at the fall-through
 * would cover every authenticated page and miss exactly the two pages an
 * unauthenticated user has to reach — so under an enforcing policy everyone
 * already signed in would be fine and nobody else could get in.
 */
function allow(csp: CspContext): NextResponse {
  return NextResponse.next({ request: { headers: csp.requestHeaders } });
}

/** Stamp the policy on the way out, whatever produced the response. */
function applyCspHeaders(response: NextResponse, csp: CspContext): NextResponse {
  if (csp.responseCsp) {
    response.headers.set("Content-Security-Policy", csp.responseCsp);
  } else {
    response.headers.delete("Content-Security-Policy");
  }
  if (csp.responseReportOnlyCsp) {
    response.headers.set(
      "Content-Security-Policy-Report-Only",
      csp.responseReportOnlyCsp,
    );
  } else {
    response.headers.delete("Content-Security-Policy-Report-Only");
  }
  return response;
}

/**
 * Entry point. Kept as a thin wrapper so the policy is applied to *every*
 * response this proxy can produce — pass-throughs, redirects and the JSON 401s
 * and 403s alike — on one line that no future early return can route around.
 */
export async function proxy(request: NextRequest) {
  const csp = createCspContext(request);
  return applyCspHeaders(await route(request, csp), csp);
}

async function route(request: NextRequest, csp: CspContext): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Allow static assets
  if (isStaticAsset(pathname)) {
    return allow(csp);
  }

  // Allow public paths (login, setup, and their API routes)
  if (isPublicPath(pathname)) {
    return allow(csp);
  }

  // The read-only public API authenticates with an API key (not the JWT
  // cookie). Edge middleware can't do the required DB lookup, so let these
  // requests through — each route handler enforces the key via requireApiKey().
  if (pathname.startsWith("/api/public/")) {
    return allow(csp);
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
      return allow(csp);
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
  const adminish = isAdminish(role);
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
  if (isSuperAdminPath(pathname) && role !== SUPER_ADMIN_ROLE) {
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return applyRefresh(NextResponse.redirect(new URL("/dashboard", request.url)));
  }

  // Admin (or SuperAdmin) required for the rest of the admin surface
  if (isAdminPath(pathname) && !adminish) {
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return applyRefresh(NextResponse.redirect(new URL("/dashboard", request.url)));
  }

  return applyRefresh(allow(csp));
}

export const config = {
  matcher: [
    /*
     * Everything except the static-asset paths, which are served straight from
     * disk and need neither auth nor a per-request nonce:
     *  - _next/static  (build output)
     *  - _next/image   (image optimizer)
     *  - favicon.ico
     *
     * This alternation must stay equal to `STATIC_ASSET_PREFIXES` in
     * `lib/csp.ts`, which is what `next.config.ts` uses to put a policy on these
     * same paths. Next requires this value to be a statically analysable
     * literal, so it cannot import that list — the duplication is forced, and
     * the consequence of the two drifting apart is a path with either no
     * Content-Security-Policy or two of them. Note the escaped dot: unescaped it
     * is a wildcard, which also excluded paths like /faviconXico.
     */
    "/((?!_next/static|_next/image|favicon\\.ico).*)",
  ],
};
