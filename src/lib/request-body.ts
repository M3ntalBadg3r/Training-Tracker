/**
 * Safe JSON body reading for the bulk-import routes.
 *
 * The importers all did a bare `await request.json()`, which has three problems:
 * malformed JSON rejects and surfaces as an opaque 500 rather than a 400; there
 * is no `Content-Type` check, so anything can be posted at them; and there is no
 * size limit before the body is buffered and parsed. Their existing row caps
 * (10k–50k) don't help, because a row is unbounded in width — the cap is checked
 * only after the whole document has been parsed into memory.
 *
 * `src/app/api/admin/branding/route.ts` established the pattern this follows:
 * check the declared length *before* buffering, because a check afterwards is
 * too late to protect against the thing it is checking for.
 */

import { NextRequest, NextResponse } from "next/server";

/**
 * Default ceiling on an import body. Comfortably above a large real import
 * (50k rows of ordinary text) while still bounding what one request can make the
 * server hold and parse. Override with IMPORT_MAX_BODY_MB.
 */
export const MAX_IMPORT_BODY_BYTES =
  Math.max(1, Number(process.env.IMPORT_MAX_BODY_MB) || 32) * 1024 * 1024;

export type JsonBodyResult =
  | { ok: true; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  | { ok: false; response: NextResponse };

/**
 * Read and parse a JSON request body with a content-type check, a size cap and
 * proper 400-on-malformed handling.
 *
 * A drop-in for `await request.json()`:
 *
 *   const parsed = await readJsonBody(request);
 *   if (!parsed.ok) return parsed.response;
 *   const body = parsed.body;
 */
export async function readJsonBody(
  request: NextRequest,
  maxBytes: number = MAX_IMPORT_BODY_BYTES
): Promise<JsonBodyResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Expected a JSON request body." },
        { status: 415 }
      ),
    };
  }

  // Declared length first — the point is to refuse before buffering.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Import is too large. Split it into smaller files." },
        { status: 413 }
      ),
    };
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Could not read the request body." },
        { status: 400 }
      ),
    };
  }

  // A request without a Content-Length (chunked) skips the check above, so
  // re-check the actual bytes before handing them to JSON.parse, which is what
  // multiplies them into objects.
  if (raw.length > maxBytes) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Import is too large. Split it into smaller files." },
        { status: 413 }
      ),
    };
  }

  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Request body is not valid JSON." },
        { status: 400 }
      ),
    };
  }
}
