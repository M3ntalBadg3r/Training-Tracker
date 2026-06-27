/**
 * Shared boilerplate for the read-only public API (`/api/public/v1/*`):
 * authenticate the API key, enforce the per-key rate limit, and resolve the
 * company-id filter the request is allowed to read.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleAuthError } from "@/lib/auth";
import {
  requireApiKey,
  checkApiKeyRateLimit,
  resolveApiKeyCompanyFilter,
} from "@/lib/api-key";

export interface PublicApiContext {
  /** Company ids this request may read. Empty = no results (out-of-scope ?companyId=). */
  companyIds: number[];
}

/**
 * Run the standard guard chain for a public API request. On success returns the
 * resolved context; on any failure returns a ready-to-send NextResponse (401 for
 * a bad key, 429 when rate-limited). Callers should check `instanceof NextResponse`.
 */
export async function authorizePublicRequest(
  request: NextRequest
): Promise<PublicApiContext | NextResponse> {
  let auth;
  try {
    auth = await requireApiKey(request);
  } catch (error) {
    return handleAuthError(error);
  }

  if (!checkApiKeyRateLimit(auth.apiKeyId)) {
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
