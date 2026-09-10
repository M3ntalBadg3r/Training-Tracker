import crypto from "crypto";

/**
 * HMAC authentication for the cron-triggered endpoints.
 *
 * ## What is signed, and why it matters
 *
 * The original scheme signed *only* the UTC date, which made the resulting
 * signature a static bearer token: identical for every endpoint, valid for the
 * whole day, and replayable by anyone who saw it once (a process list, a proxy
 * access log). It is the sole guard on `scheduled-exports/execute`.
 *
 * A signature now covers the **method, the exact path, a timestamp and a
 * nonce**, so it authorises exactly one call to one endpoint inside a short
 * window, and only once:
 *
 *   v1:<METHOD>:<path>:<unix-seconds>:<nonce>
 *
 * - **path** — a signature captured from one endpoint cannot be replayed
 *   against another (it used to open all three).
 * - **timestamp** — bounds validity to {@link CRON_MAX_SKEW_SECONDS}, down from
 *   24 hours.
 * - **nonce** — single-use, enforced by `consumeCronNonce` in
 *   `lib/cron-nonce.ts`, so even inside the window a captured signature is
 *   already spent by the legitimate request that carried it.
 *
 * ## Keep this in lockstep with the shell side
 *
 * `deploy/lib/cron-sign.sh` builds the same string for the three cron scripts.
 * **The two definitions must agree byte for byte** — the same standing rule as
 * `UPDATE_REQUESTS` vs `update-agent.sh`. If they drift, every scheduled backup,
 * export and credential check silently starts returning 401.
 *
 * ## This module must not import Prisma
 *
 * `src/proxy.ts` imports {@link verifyCronRequest}, and the proxy has no
 * database access. Verification is therefore split in two:
 *
 * - **`verifyCronRequest`** (here) — stateless; proves the signature is
 *   authentic, well-formed and current. Safe for the proxy, which only uses it
 *   to decide whether to let the request reach the handler.
 * - **`authorizeCronRequest`** (`lib/cron-nonce.ts`) — the stateless check *plus*
 *   single-use nonce consumption.
 *
 * **Route handlers must call `authorizeCronRequest`, never `verifyCronRequest`
 * alone** — the handler is the real security boundary, and the replay guard only
 * exists there. The proxy being the more permissive of the two is fine: it
 * cannot authorise anything the handler does not re-check.
 *
 * If CRON_SECRET is not configured, cron auth is denied (secure default).
 */

/** Version tag on the signed string, so the format can be changed later. */
export const CRON_SIGNATURE_VERSION = "v1";

/**
 * How far a request's timestamp may be from the server's clock, in seconds.
 * Applied in both directions to tolerate modest clock skew between the cron
 * host and the app (they are the same machine today, but need not be).
 * Doubles as the nonce retention window — see `lib/cron-nonce.ts`.
 */
export const CRON_MAX_SKEW_SECONDS = 300;

/** A nonce is exactly 16 random bytes, lowercase hex (`openssl rand -hex 16`). */
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** Digits only, and short enough that Number() cannot overflow into nonsense. */
const TIMESTAMP_PATTERN = /^\d{1,12}$/;

/** The minimum shape this module needs; `NextRequest` satisfies it. */
export interface CronRequestLike {
  method: string;
  headers: { get(name: string): string | null };
  nextUrl: { pathname: string };
}

export interface CronVerification {
  /** Whether the signature is authentic, well-formed and inside the window. */
  ok: boolean;
  /** The presented nonce, when `ok` — the caller passes it to `consumeCronNonce`. */
  nonce?: string;
}

/**
 * Build the canonical string that both sides sign.
 *
 * Mirrored by `cron_signing_string` in `deploy/lib/cron-sign.sh`; change both
 * together or scheduled jobs stop authenticating.
 */
export function cronSigningString(
  method: string,
  pathname: string,
  timestamp: string,
  nonce: string
): string {
  return `${CRON_SIGNATURE_VERSION}:${method.toUpperCase()}:${pathname}:${timestamp}:${nonce}`;
}

/**
 * Stateless verification of a cron request's signature.
 *
 * Returns the nonce alongside the verdict so the caller can enforce single use.
 * See the module comment: handlers must go through `authorizeCronRequest`.
 */
export function verifyCronRequest(request: CronRequestLike): CronVerification {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false };

  const signature = request.headers.get("x-cron-signature");
  const timestamp = request.headers.get("x-cron-timestamp");
  const nonce = request.headers.get("x-cron-nonce");
  if (!signature || !timestamp || !nonce) return { ok: false };

  // Reject malformed values before they reach the HMAC or the nonce store — a
  // nonce becomes a database key, so its shape is bounded here.
  if (!TIMESTAMP_PATTERN.test(timestamp)) return { ok: false };
  if (!NONCE_PATTERN.test(nonce)) return { ok: false };

  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (skewSeconds > CRON_MAX_SKEW_SECONDS) return { ok: false };

  const expected = crypto
    .createHmac("sha256", secret)
    .update(
      cronSigningString(request.method, request.nextUrl.pathname, timestamp, nonce)
    )
    .digest("hex");

  // Timing-safe comparison. timingSafeEqual throws on a length mismatch, which
  // a malformed hex signature produces, so the try/catch is load-bearing.
  try {
    const ok = crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
    return ok ? { ok: true, nonce } : { ok: false };
  } catch {
    return { ok: false };
  }
}
