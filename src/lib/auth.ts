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
const JWT_EXPIRY = "8h";

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
}

export async function createToken(payload: TokenPayload): Promise<string> {
  const { sub, pendingMfaEnrollment, ...rest } = payload;
  const claims: Record<string, unknown> = { ...rest, sub: String(sub) };
  if (pendingMfaEnrollment) claims.pendingMfaEnrollment = true;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
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
    };
  } catch {
    return null;
  }
}

// --- Cookies ---

export function setAuthCookie(response: NextResponse, token: string): void {
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 8 * 60 * 60, // 8 hours
  });
}

export function clearAuthCookie(response: NextResponse): void {
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
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

export function generateMfaSecret(username: string): {
  secret: string;
  uri: string;
} {
  const secret = new Secret();
  const totp = new TOTP({
    issuer: "Training Tracker",
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
