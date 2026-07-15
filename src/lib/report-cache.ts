/**
 * Short-TTL in-memory cache for the expensive interactive report / dashboard /
 * program-compliance computations.
 *
 * Motivation: those read paths recompute a full query + JS-aggregation set on
 * every request, so N concurrent viewers of the same dashboard each re-run the
 * identical heavy work. A short cache (30s staleness is approved) collapses that
 * to one computation per key per window, and in-flight de-duplication collapses
 * a burst of concurrent identical requests to a single loader run.
 *
 * Mirrors the module-level Map + TTL-timestamp pattern in `system-settings.ts`,
 * generalised. TTL-only expiry (no per-entry LRU) is fine given the approved
 * staleness; the whole store is also flushed on data writes via
 * `invalidateReportCache()` so admins never see stale data right after an
 * import/edit.
 *
 * Cache-key safety is the caller's responsibility: a key MUST encode the company
 * scope AND every query param that changes the result, or one tenant's / one
 * view's data would be served to another. Use `scopeKey()` for the scope part.
 * Callers already fail closed on an empty company scope (they early-return before
 * the cached data step), so an empty scope is never stored here.
 */

/** Default cache lifetime (ms). Overridable via REPORT_CACHE_TTL_MS; 0 disables. */
const DEFAULT_TTL_MS = 30_000;

const TTL_MS = (() => {
  const raw = Number(process.env.REPORT_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
})();

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Stable key fragment for a resolved company scope.
 * `null` = unrestricted (SuperAdmin, all companies); otherwise the sorted id
 * list so `[2,1]` and `[1,2]` collapse to the same key.
 */
export function scopeKey(scope: number[] | null): string {
  return scope === null ? "all" : [...scope].sort((a, b) => a - b).join(",");
}

/**
 * Return the cached value for `key` if it is still fresh, otherwise run `loader`,
 * store its result, and return it. Concurrent calls with the same key while a
 * load is in flight all await the same loader promise (one DB round-trip).
 */
export async function cachedReport<T>(key: string, loader: () => Promise<T>): Promise<T> {
  // Escape hatch / parity mode: caching disabled entirely.
  if (TTL_MS === 0) return loader();

  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = (async () => {
    const value = await loader();
    store.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise as Promise<T>;
}

/**
 * Flush the entire cache. Called after any write that changes report inputs
 * (training-taken / student / training-data / program-data mutations, imports)
 * so the next read recomputes against fresh data. In-flight loaders that started
 * before the flush are left to complete; the wholesale clear plus a fresh read
 * afterwards keeps post-write staleness within the approved window.
 */
export function invalidateReportCache(): void {
  store.clear();
}
