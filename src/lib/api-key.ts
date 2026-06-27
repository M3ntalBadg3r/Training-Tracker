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
import { getClientIp, checkRateLimit } from "@/lib/rate-limit";

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
function extractKey(request: NextRequest): string | null {
  const auth = request.headers.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const headerKey = request.headers.get("x-api-key");
  if (headerKey) return headerKey.trim();
  return null;
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
  const presented = extractKey(request);
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
 * Apply the per-key rate limit. Returns true if the request is allowed, false if
 * the key has exceeded its budget for the current window.
 */
export function checkApiKeyRateLimit(apiKeyId: number): boolean {
  return checkRateLimit(`api:${apiKeyId}`, API_RATE_LIMIT, API_RATE_WINDOW_MS);
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
export function resolveApiKeyCompanyFilter(
  companyIds: number[],
  requestedRaw: string | null
): number[] {
  const requested = requestedRaw ? Number(requestedRaw) : NaN;
  if (Number.isNaN(requested)) return companyIds;
  return companyIds.includes(requested) ? [requested] : [];
}
