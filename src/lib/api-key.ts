/**
 * Read-only public API key utilities.
 *
 * Keys are high-entropy random tokens of the form `tt_live_<base64url>`. Only a
 * SHA-256 hash is ever persisted (`api_keys.key_hash`); the plaintext is shown
 * to the admin exactly once at creation. High entropy means a fast, constant-
 * time-comparable hash (SHA-256) is appropriate — there is nothing to brute
 * force the way there is with a human password, and an indexed hash lets us look
 * the key up in one query.
 *
 * A key is scoped to an explicit set of companies via the `api_key_companies`
 * join table; requests authenticated by the key may only read those companies'
 * data, reusing the same company-filter semantics as the interactive UI.
 */

import crypto from "crypto";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { AuthError } from "@/lib/auth";
import { getClientIp, checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";

const KEY_PREFIX = "tt_live_";
// Number of leading characters (including the `tt_live_` prefix) stored in
// plaintext for display/identification in the admin list. Never enough to
// reconstruct the secret.
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 6;
// Only persist lastUsedAt at most this often to avoid a DB write per request.
const LAST_USED_THROTTLE_MS = 60_000;

export interface GeneratedApiKey {
  plaintext: string;
  keyHash: string;
  keyPrefix: string;
}

/** Hash a plaintext key for storage / lookup (SHA-256 hex). */
export function hashApiKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * Generate a fresh API key. Returns the plaintext (to show once), its hash (to
 * store), and a short non-secret display prefix.
 */
export function generateApiKey(): GeneratedApiKey {
  const random = crypto.randomBytes(32).toString("base64url");
  const plaintext = `${KEY_PREFIX}${random}`;
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/** Extract the presented key from the Authorization (Bearer) or X-API-Key header. */
export function extractPresentedKey(request: NextRequest): string | null {
  const auth = request.headers.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const headerKey = request.headers.get("x-api-key");
  if (headerKey) return headerKey.trim();
  return null;
}

/**
 * Mask a presented key for display/audit: keep the non-secret prefix and elide the
 * rest. Never returns enough to reconstruct the key. Used by the failed-attempt log
 * so a mistyped valid key is not written out in full.
 */
export function maskPresentedKey(presented: string): string {
  const head = presented.slice(0, DISPLAY_PREFIX_LENGTH);
  return presented.length > DISPLAY_PREFIX_LENGTH ? `${head}…` : head;
}

export interface ApiKeyAuth {
  apiKeyId: number;
  name: string;
  companyIds: number[];
}

/**
 * Authenticate a public-API request by its key. Throws an AuthError (handled by
 * `handleAuthError`) when the key is missing, unknown, disabled, revoked, or
 * expired. On success returns the key's id and the company ids it may read.
 *
 * Records lastUsedAt/lastUsedIp (throttled) as a lightweight audit trail.
 */
export async function requireApiKey(request: NextRequest): Promise<ApiKeyAuth> {
  const presented = extractPresentedKey(request);
  if (!presented) {
    throw new AuthError("Missing API key", 401);
  }

  const keyHash = hashApiKey(presented);
  const record = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: { companies: { select: { companyId: true } } },
  });

  if (!record || !record.enabled || record.revokedAt) {
    throw new AuthError("Invalid API key", 401);
  }
  if (record.expiresAt && record.expiresAt <= new Date()) {
    throw new AuthError("API key has expired", 401);
  }

  // Throttled audit update — fire-and-forget so it never blocks the response.
  const now = Date.now();
  if (!record.lastUsedAt || now - record.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    prisma.apiKey
      .update({
        where: { id: record.id },
        data: { lastUsedAt: new Date(), lastUsedIp: getClientIp(request) },
      })
      .catch(() => {});
  }

  return {
    apiKeyId: record.id,
    name: record.name,
    companyIds: record.companies.map((c) => c.companyId),
  };
}

// Per-key request budget for the public API (sliding window). Generous enough
// for normal polling/sync workloads while bounding abuse from a single key.
const API_RATE_LIMIT = 120;
const API_RATE_WINDOW_MS = 60_000;

/**
 * Apply the per-key rate limit. Resolves true if the request is allowed, false if
 * the key has exceeded its budget for the current window.
 */
/**
 * Per-key rate limit. Returns the limiter's full verdict rather than a bare
 * boolean, because the caller needs `retryAfterMs` to send a `Retry-After`
 * header — this used to narrow to `result.allowed` and throw the wait away, so
 * every public-API 429 told a client it was throttled without telling it for
 * how long, and an integration had no option but to guess a backoff.
 */
export async function checkApiKeyRateLimit(apiKeyId: number): Promise<RateLimitResult> {
  return checkRateLimit(`api:${apiKeyId}`, API_RATE_LIMIT, API_RATE_WINDOW_MS);
}

/** `Retry-After` in seconds, floored at 1 — the header has no sub-second form. */
export function retryAfterSeconds(retryAfterMs: number): string {
  return String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
}

// Throttle *invalid*-key attempts per client IP so the public API can't be used
// as an oracle to hammer for a valid key (defence-in-depth — keys are 256-bit
// random, so this is DoS-noise mitigation rather than credential protection).
export const INVALID_KEY_LIMIT = 20;
const INVALID_KEY_WINDOW_MS = 5 * 60_000;

/**
 * Record a failed key attempt from the given IP and report whether the IP has
 * exceeded its invalid-attempt budget for the current window.
 */
export async function checkInvalidApiKeyRateLimit(ip: string): Promise<boolean> {
  const result = await checkRateLimit(
    `apikey-fail:${ip}`,
    INVALID_KEY_LIMIT,
    INVALID_KEY_WINDOW_MS
  );
  return result.allowed;
}

/**
 * Resolve the effective company-id filter for a public-API request: intersect
 * the key's granted companies with an optional `?companyId=` query value.
 * Mirrors `resolveCompanyFilter` in lib/company-scope.ts, but the key's company
 * list is always the (non-null) allowed set — a public key is never unrestricted.
 *
 * Returns the list of company ids to filter by; an empty array means "no
 * results" (the request asked for a company the key cannot read).
 */
/**
 * Resolve `?companyId=` against the key's grant.
 *
 * Returns `null` when a numeric id was supplied that the key was NOT granted,
 * so the caller can answer 400 rather than serving an empty result. That used
 * to return `[]`, which the query layer turns into `in: []` — a clean 200 with
 * no rows, **indistinguishable from a company that genuinely holds no data**.
 * An integration pointed at the wrong company therefore looked like an
 * integration reporting honest zeroes, with nothing anywhere to say otherwise.
 *
 * **Refusing leaks nothing**, which is what makes the error safe to send: this
 * decision reads only `companyIds` — the key's own grant, which the caller can
 * already enumerate from `GET /api/public/v1` — and never touches the database.
 * It cannot answer, and so cannot disclose, whether the requested company
 * exists at all. A 403/404 split over live rows WOULD be an existence oracle;
 * this is not that.
 *
 * A non-numeric value still falls through to the full grant rather than
 * erroring. That is deliberately left alone: it is the documented behaviour,
 * changing it would break a second thing in the same pass, and unlike the
 * ungranted case it does not quietly mimic a real answer.
 */
export function resolveApiKeyCompanyFilter(
  companyIds: number[],
  requestedRaw: string | null
): number[] | null {
  const requested = requestedRaw ? Number(requestedRaw) : NaN;
  if (Number.isNaN(requested)) return companyIds;
  return companyIds.includes(requested) ? [requested] : null;
}
