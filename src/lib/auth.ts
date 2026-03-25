import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "tt-auth";
const JWT_EXPIRY = "8h";

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
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
}

export async function createToken(payload: TokenPayload): Promise<string> {
  return new SignJWT({ ...payload, sub: String(payload.sub) })
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
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 60 * 60, // 8 hours
  });
}

export function clearAuthCookie(response: NextResponse): void {
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
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
  if (requiredRole && user.role !== requiredRole) {
    throw new AuthError("Forbidden", 403);
  }
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
  // Dynamic import workaround: otpauth uses named export TOTP
  const { TOTP, Secret } = require("otpauth") as typeof import("otpauth");
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
  const QRCode = require("qrcode") as typeof import("qrcode");
  return QRCode.toDataURL(uri);
}

export function verifyMfaToken(secret: string, token: string): boolean {
  const { TOTP, Secret } = require("otpauth") as typeof import("otpauth");
  const totp = new TOTP({
    issuer: "Training Tracker",
    label: "user",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

// Re-export cookie name for middleware
export { COOKIE_NAME };
