import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

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

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow static assets
  if (isStaticAsset(pathname)) {
    return NextResponse.next();
  }

  // Allow public paths
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Check if setup is needed (no users exist)
  // We call the setup API internally to check
  try {
    const setupUrl = new URL("/api/auth/setup", request.url);
    const setupRes = await fetch(setupUrl.toString(), {
      headers: { cookie: request.headers.get("cookie") || "" },
    });
    const setupData = await setupRes.json();
    if (setupData.needsSetup) {
      if (pathname === "/setup" || pathname === "/api/auth/setup") {
        return NextResponse.next();
      }
      return NextResponse.redirect(new URL("/setup", request.url));
    }
  } catch {
    // If setup check fails, continue with auth check
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

  // Admin role check for admin paths
  if (isAdminPath(pathname) && payload.role !== "Admin") {
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
