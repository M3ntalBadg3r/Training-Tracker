import { NextRequest, NextResponse } from "next/server";
import { authorizePublicRequest } from "@/lib/public-api";
import { buildOpenApiDocument } from "@/lib/public-api-spec";

/**
 * GET /api/public/v1/openapi.json — the OpenAPI 3.1 description of this API.
 *
 * Built from `lib/public-api-spec.ts`, the same module the self-describing
 * index renders from and `scripts/check-api-spec.mjs` checks against the code,
 * so the three cannot disagree about which endpoints exist or what they accept.
 *
 * **Key-gated like every other endpoint.** A spec reveals no data, but it does
 * describe the whole surface, and making it unauthenticated would mean adding a
 * `PUBLIC_HANDLERS` entry — an assertion that the handler is safe to expose to
 * the internet with no credentials. A generated copy is committed at
 * `docs/openapi.json` instead, which is how someone reads it before they hold a
 * key, so nothing is gained by opening the endpoint.
 *
 * The `.json` suffix is safe here: `proxy.ts:isStaticAsset` early-returns for
 * anything under `/api/`, precisely so a route reachable at a URL ending in a
 * static-looking extension cannot skip the auth chain.
 *
 * No `Cache-Control` and no `cachedReport`: the document is built from a
 * module-level constant with no database access, so there is nothing to cache.
 */
export async function GET(request: NextRequest) {
  const ctx = await authorizePublicRequest(request);
  if (ctx instanceof NextResponse) return ctx;

  return NextResponse.json(buildOpenApiDocument());
}
