/**
 * Shared boilerplate for the read-only public API (`/api/public/v1/*`): check
 * the global on/off switch, authenticate the API key, enforce the per-key rate
 * limit, and resolve the company-id filter the request is allowed to read.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleAuthError } from "@/lib/auth";
import {
  requireApiKey,
  checkApiKeyRateLimit,
  checkInvalidApiKeyRateLimit,
  resolveApiKeyCompanyFilter,
  extractPresentedKey,
  retryAfterSeconds,
} from "@/lib/api-key";
import { getClientIp } from "@/lib/rate-limit";
import { recordApiFailure } from "@/lib/failed-attempts";
import { getPublicApiEnabled } from "@/lib/system-settings";

export interface PublicApiContext {
  /**
   * Company ids this request may read.
   *
   * Empty now means only one thing: the key is granted no companies at all. It
   * used to ALSO carry "a `?companyId=` outside the grant", which is why the
   * routes' `length === 0` early return exists — that case is now a 400 from
   * the guard chain and never reaches a handler.
   */
  companyIds: number[];
}

/**
 * Enforce the system-wide public-API switch. Returns a ready-to-send 503 when
 * the API is turned off, or null when it's on. Runs before key authentication so
 * a disabled API does no key lookup, no rate-limit write and no failure logging.
 */
export async function ensurePublicApiEnabled(): Promise<NextResponse | null> {
  if (await getPublicApiEnabled()) return null;
  return NextResponse.json(
    { error: "The public API is currently disabled. Contact your administrator." },
    { status: 503 }
  );
}

/**
 * Run the standard guard chain for a public API request. On success returns the
 * resolved context; on any failure returns a ready-to-send NextResponse (503 when
 * the API is disabled, 401 for a bad key, 429 when rate-limited, 400 for a
 * `?companyId=` outside the key's grant). Callers should check
 * `instanceof NextResponse`.
 *
 * **The per-key 429 carries `Retry-After`; the invalid-key 429 deliberately does
 * not.** That asymmetry is the point, not an oversight: the first is a
 * legitimate caller who needs to know how long to back off, while the second is
 * an unauthenticated attempt, and naming the exact moment the window reopens
 * would hand a key-guesser a pacing signal. The budget there is 20 per 5
 * minutes, so the information is small either way — but it is free to withhold
 * and there is no caller it would help. Do not "make the two consistent".
 */
export async function authorizePublicRequest(
  request: NextRequest
): Promise<PublicApiContext | NextResponse> {
  const disabled = await ensurePublicApiEnabled();
  if (disabled) return disabled;

  let auth;
  try {
    auth = await requireApiKey(request);
  } catch (error) {
    // Throttle repeated invalid-key attempts per IP before returning the auth
    // error, so an attacker can't spray the endpoint unbounded.
    const ip = getClientIp(request);
    const withinBudget = await checkInvalidApiKeyRateLimit(ip);
    if (!withinBudget) {
      return NextResponse.json(
        { error: "Too many invalid API key attempts. Please try again later." },
        { status: 429 }
      );
    }
    // Record the genuine (non-throttled) attempt for the admin audit log.
    const presented = extractPresentedKey(request);
    if (presented) await recordApiFailure({ presentedKey: presented, ip });
    return handleAuthError(error);
  }

  const rate = await checkApiKeyRateLimit(auth.apiKeyId);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please slow down." },
      { status: 429, headers: { "Retry-After": retryAfterSeconds(rate.retryAfterMs) } }
    );
  }

  // `null` = a numeric ?companyId= this key was not granted. Answer 400 rather
  // than serving the empty result that used to come back, which no caller could
  // tell apart from a company holding no data. Safe to name: the check reads
  // only this key's own grant and never asks whether that company exists.
  const companyIds = resolveApiKeyCompanyFilter(
    auth.companyIds,
    request.nextUrl.searchParams.get("companyId")
  );
  if (companyIds === null) {
    return NextResponse.json(
      { error: "companyId is not one of the companies this API key may read." },
      { status: 400 }
    );
  }

  return { companyIds };
}
