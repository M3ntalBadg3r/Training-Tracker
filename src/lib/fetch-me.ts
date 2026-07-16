/**
 * Shared, de-duplicated fetch of `/api/auth/me`.
 *
 * `AuthProvider` and `DateFormatProvider` both need the current user + system
 * settings and previously each fetched `/api/auth/me` on mount, so every
 * protected page load made two identical requests (each a DB read +
 * getSystemDateFormat). They mount together, so an in-flight-shared promise
 * collapses those concurrent calls into a single request.
 *
 * There is deliberately no persistent cache: each fresh load still fetches once,
 * and `refreshUser()`-style callers pass `force` so a post-login / preference
 * change always re-reads.
 */

export interface MeResponse {
  id: number;
  username: string;
  role: string;
  displayName: string;
  mfaEnabled?: boolean;
  mustEnableMfa?: boolean;
  dateFormat?: string | null;
  systemDateFormat?: string;
  pendingMfaEnrollment?: boolean;
  idleMs?: number;
  sessionExpiresAt?: number;
}

let inflight: Promise<MeResponse | null> | null = null;

/**
 * Fetch `/api/auth/me`, sharing one in-flight request between concurrent
 * callers. Returns `null` on a non-OK response or network error. Pass
 * `force = true` to bypass the shared request and always issue a fresh fetch.
 */
export function fetchMe(force = false): Promise<MeResponse | null> {
  if (!force && inflight) return inflight;
  const p = fetch("/api/auth/me")
    .then((r) => (r.ok ? (r.json() as Promise<MeResponse>) : null))
    .catch(() => null)
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}
