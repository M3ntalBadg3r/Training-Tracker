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
} from "@/lib/api-key";
import { getClientIp } from "@/lib/rate-limit";
import { recordApiFailure } from "@/lib/failed-attempts";
import { getPublicApiEnabled } from "@/lib/system-settings";

export interface PublicApiContext {
  /** Company ids this request may read. Empty = no results (out-of-scope ?companyId=). */
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
 * the API is disabled, 401 for a bad key, 429 when rate-limited). Callers should
 * check `instanceof NextResponse`.
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

  if (!(await checkApiKeyRateLimit(auth.apiKeyId))) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please slow down." },
      { status: 429 }
    );
  }

  const companyIds = resolveApiKeyCompanyFilter(
    auth.companyIds,
    request.nextUrl.searchParams.get("companyId")
  );

  return { companyIds };
}
