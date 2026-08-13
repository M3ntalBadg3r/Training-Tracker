import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";
import {
  encryptString,
  decryptString,
  isEncryptedBlob,
  isEncryptionConfigured,
} from "@/lib/crypto";

const COOKIE_NAME = "tt-auth";

// Idle (inactivity) session window used when a caller doesn't supply one — kept
// in sync with lib/system-settings.ts DEFAULT_SESSION_IDLE_MINUTES.
export const DEFAULT_IDLE_MINUTES = 30;
export const DEFAULT_IDLE_MS = DEFAULT_IDLE_MINUTES * 60 * 1000;

// Absolute maximum session length. Even a continuously-active user is forced to
// re-authenticate this long after login. Fixed (env-overridable), not the
// per-user idle window.
export const ABSOLUTE_SESSION_MS =
  (Number(process.env.SESSION_ABSOLUTE_HOURS) || 8) * 60 * 60 * 1000;

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  if (secret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters for adequate security");
  return new TextEncoder().encode(secret);
}

// --- Password ---

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(password)) return "Password must contain an uppercase letter";
  if (!/[a-z]/.test(password)) return "Password must contain a lowercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain a number";
  if (!/[^A-Za-z0-9]/.test(password)) return "Password must contain a special character";
  return null;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// --- JWT ---

export interface TokenPayload {
  sub: number;
  username: string;
  role: string;
  displayName: string;
  // When true, the session is in a locked state until MFA enrolment completes;
  // proxy.ts only allows the /setup-mfa page and the MFA setup/verify endpoints.
  pendingMfaEnrollment?: boolean;
  // Epoch ms of the original login — anchors the absolute-session cap. Set once
  // at login/enrolment; preserved (not reset) as the proxy slides the token.
  sessionStart?: number;
  // Idle window (ms) baked into the token so the edge proxy can slide the
  // expiry without a DB read. Defaults apply for legacy tokens minted before
  // this claim existed.
  idleMs?: number;
}

interface CreateTokenOptions {
  idleMs?: number;
  sessionStart?: number;
}

export async function createToken(
  payload: TokenPayload,
  options: CreateTokenOptions = {}
): Promise<string> {
  const { sub, pendingMfaEnrollment, ...rest } = payload;
  const idleMs = options.idleMs ?? payload.idleMs ?? DEFAULT_IDLE_MS;
  const sessionStart = options.sessionStart ?? payload.sessionStart ?? Date.now();
  const claims: Record<string, unknown> = {
    ...rest,
    sub: String(sub),
    sessionStart,
    idleMs,
  };
  if (pendingMfaEnrollment) claims.pendingMfaEnrollment = true;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + idleMs) / 1000))
    .sign(getJwtSecret());
}

export async function verifyToken(
  token: string
): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return {
      sub: Number(payload.sub),
      username: payload.username as string,
      role: payload.role as string,
      displayName: payload.displayName as string,
      pendingMfaEnrollment: payload.pendingMfaEnrollment === true,
      sessionStart:
        typeof payload.sessionStart === "number" ? payload.sessionStart : undefined,
      idleMs: typeof payload.idleMs === "number" ? payload.idleMs : undefined,
    };
  } catch {
    return null;
  }
}

// --- Cookies ---

/**
 * Determine whether the auth cookie should carry the `Secure` attribute for
 * this request. We key this off the *actual* request protocol rather than
 * NODE_ENV: browsers silently drop `Secure` cookies delivered over plain HTTP,
 * which would otherwise make login impossible on an HTTP-only LAN/VM deployment
 * (NODE_ENV=production but no TLS). Prefer the deployment's canonical
 * APP_BASE_URL (authoritative, not spoofable), then fall back to
 * `x-forwarded-proto` (set by a TLS-terminating reverse proxy) and finally the
 * request URL's own protocol.
 */
export function isRequestSecure(request: NextRequest): boolean {
  const base = process.env.APP_BASE_URL?.trim();
  if (base) return base.toLowerCase().startsWith("https://");
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ??
    new URL(request.url).protocol.replace(":", "");
  return proto === "https";
}

export function setAuthCookie(
  response: NextResponse,
  token: string,
  secure: boolean,
  maxAgeSeconds: number = DEFAULT_IDLE_MS / 1000
): void {
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    // Lax (not Strict): the cookie must ride along on top-level GET navigations
    // — including page reloads. iOS Safari withholds SameSite=Strict cookies on
    // address-bar reloads / pull-to-refresh, which logged mobile users out on
    // every refresh. Lax still blocks cross-site POSTs, so CSRF protection for
    // the app's same-origin mutations is unaffected.
    sameSite: "lax",
    path: "/",
    // Cookie lifetime tracks the sliding idle window; re-set on every slide.
    maxAge: Math.floor(maxAgeSeconds),
  });
}

export function clearAuthCookie(
  response: NextResponse,
  secure: boolean
): void {
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure,
    // Keep symmetric with setAuthCookie (Lax) so the clear matches the stored cookie.
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function getAuthFromRequest(
  request: NextRequest
): Promise<TokenPayload | null> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyToken(token);
}

// --- Auth Guards ---

export async function requireAuth(
  request: NextRequest,
  requiredRole?: string
): Promise<TokenPayload> {
  const user = await getAuthFromRequest(request);
  if (!user) {
    throw new AuthError("Unauthorized", 401);
  }
  if (requiredRole) {
    // "Admin" should accept SuperAdmin too — SuperAdmin is a superset of Admin.
    if (requiredRole === "Admin") {
      if (user.role !== "Admin" && user.role !== "SuperAdmin") {
        throw new AuthError("Forbidden", 403);
      }
    } else if (user.role !== requiredRole) {
      throw new AuthError("Forbidden", 403);
    }
  }
  return user;
}

export async function requireSuperAdmin(request: NextRequest): Promise<TokenPayload> {
  const user = await getAuthFromRequest(request);
  if (!user) throw new AuthError("Unauthorized", 401);
  if (user.pendingMfaEnrollment) throw new AuthError("MFA enrollment required", 403);
  if (user.role !== "SuperAdmin") throw new AuthError("Forbidden", 403);
  return user;
}

// Reject sessions that are still in pending-MFA-enrolment state. Callers that
// must interoperate with the enrolment flow itself (the MFA setup/verify
// routes, /api/auth/me, /api/auth/logout) use `getAuthFromRequest` directly.
export async function requireFullSession(
  request: NextRequest,
  requiredRole?: string
): Promise<TokenPayload> {
  const user = await requireAuth(request, requiredRole);
  if (user.pendingMfaEnrollment) throw new AuthError("MFA enrollment required", 403);
  return user;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function handleAuthError(error: unknown): NextResponse {
  if (error instanceof AuthError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status }
    );
  }
  throw error;
}

// --- TOTP / MFA ---

/**
 * The issuer is the name the user sees against the entry in their authenticator
 * app, so a white-labelled install passes its configured app name in. Taken as
 * a parameter rather than read here to keep this module free of a dependency on
 * the settings store.
 */
export function generateMfaSecret(
  username: string,
  issuer: string = "Training Tracker"
): {
  secret: string;
  uri: string;
} {
  const secret = new Secret();
  const totp = new TOTP({
    issuer,
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });
  return {
    secret: secret.base32,
    uri: totp.toString(),
  };
}

export async function generateMfaQrCode(uri: string): Promise<string> {
  return QRCode.toDataURL(uri);
}

/**
 * Wrap a TOTP base32 secret for storage in users.mfa_secret. If
 * ENCRYPTION_KEY is configured the secret is encrypted; otherwise it is
 * returned as-is (legacy plaintext) so pre-key deployments keep working.
 */
export function sealMfaSecret(base32: string): string {
  if (!isEncryptionConfigured()) return base32;
  return encryptString(base32);
}

/** Unwrap whatever is in users.mfa_secret — handles both formats. */
export function openMfaSecret(stored: string): string {
  return isEncryptedBlob(stored) ? decryptString(stored) : stored;
}

export function verifyMfaToken(storedSecret: string, token: string): boolean {
  const base32 = openMfaSecret(storedSecret);
  // issuer/label are descriptive metadata only — validation depends solely on
  // the secret and the algorithm/digits/period, so branding is irrelevant here.
  const totp = new TOTP({
    issuer: "Training Tracker",
    label: "user",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32),
  });
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

// Re-export cookie name for middleware
export { COOKIE_NAME };
