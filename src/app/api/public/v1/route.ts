import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError } from "@/lib/auth";
import {
  requireApiKey,
  checkApiKeyRateLimit,
  checkInvalidApiKeyRateLimit,
  extractPresentedKey,
  retryAfterSeconds,
} from "@/lib/api-key";
import { getClientIp } from "@/lib/rate-limit";
import { recordApiFailure } from "@/lib/failed-attempts";
import { ensurePublicApiEnabled } from "@/lib/public-api";
import { buildIndexEndpoints } from "@/lib/public-api-spec";

/**
 * GET /api/public/v1 — self-describing index. Confirms the key works and reports
 * which companies it can read plus the available read-only endpoints.
 *
 * This route keeps its own guard chain (it needs the key's name/companies, which
 * `authorizePublicRequest` doesn't surface), so it checks the global switch itself.
 */
export async function GET(request: NextRequest) {
  const disabled = await ensurePublicApiEnabled();
  if (disabled) return disabled;

  let auth;
  try {
    auth = await requireApiKey(request);
  } catch (error) {
    const ip = getClientIp(request);
    const withinBudget = await checkInvalidApiKeyRateLimit(ip);
    if (!withinBudget) {
      return NextResponse.json(
        { error: "Too many invalid API key attempts. Please try again later." },
        { status: 429 }
      );
    }
    const presented = extractPresentedKey(request);
    if (presented) await recordApiFailure({ presentedKey: presented, ip });
    return handleAuthError(error);
  }
  // Kept byte-identical to `authorizePublicRequest`'s per-key 429, Retry-After
  // included — this route hand-rolls the guard chain because it needs the key's
  // own name and companies, so the two are the one place the public API can
  // disagree with itself about how a throttled caller is answered.
  const rate = await checkApiKeyRateLimit(auth.apiKeyId);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please slow down." },
      { status: 429, headers: { "Retry-After": retryAfterSeconds(rate.retryAfterMs) } }
    );
  }

  const companies = await prisma.company.findMany({
    where: { id: { in: auth.companyIds } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({
    name: "Training Tracker Public API",
    version: "v1",
    keyName: auth.name,
    companies,
    // Rendered from lib/public-api-spec.ts, the same module that builds
    // /api/public/v1/openapi.json and that scripts/check-api-spec.mjs holds to
    // the code. This list used to be written out here by hand and drifted:
    // training-records was described without any of its four filters.
    endpoints: buildIndexEndpoints(),
    notes: "All endpoints are read-only. Send the key as 'Authorization: Bearer <key>'. Use ?companyId= to scope to one of your companies. Compliance planning is returned as aggregates only — this API never returns the named candidate or renewal rosters the in-app planner shows. A full OpenAPI 3.1 description is available at /api/public/v1/openapi.json.",
  });
}
