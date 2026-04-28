import { SignJWT, jwtVerify } from "jose";
import { NextRequest } from "next/server";
import crypto from "crypto";

export const OAUTH_STATE_COOKIE = "tt-oauth-state";
const OAUTH_STATE_PATH = "/api/admin/scheduled-exports/credentials/oauth";
const OAUTH_STATE_TTL_SECONDS = 600; // 10 minutes

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  if (secret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters for adequate security");
  return new TextEncoder().encode(secret);
}

export interface OAuthStatePayload {
  provider: string;
  nonce: string;
}

export async function signOAuthState(provider: string): Promise<string> {
  const nonce = crypto.randomUUID();
  return new SignJWT({ provider, nonce })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${OAUTH_STATE_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

export async function verifyOAuthState(
  token: string,
  expectedProvider: string,
): Promise<OAuthStatePayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (payload.provider !== expectedProvider) return null;
    return {
      provider: payload.provider as string,
      nonce: payload.nonce as string,
    };
  } catch {
    return null;
  }
}

export const OAUTH_STATE_COOKIE_OPTIONS = {
  httpOnly: true as const,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: OAUTH_STATE_PATH,
  maxAge: OAUTH_STATE_TTL_SECONDS,
};

export function getRedirectUri(req: NextRequest, provider: string): string {
  const proto =
    req.headers.get("x-forwarded-proto") ??
    new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) throw new Error("Cannot determine host for OAuth redirect URI");
  return `${proto}://${host}${OAUTH_STATE_PATH}/${provider}/callback`;
}
