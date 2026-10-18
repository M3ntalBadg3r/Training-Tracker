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
 * generalised. The whole store is also flushed on data writes via
 * `invalidateReportCache()` so admins never see stale data right after an
 * import/edit.
 *
 * **The store is bounded.** Keys combine the company scope with every filter,
 * so across thousands of companies the key space is effectively unlimited, and
 * an expired entry used to be dropped only when the same key was requested
 * again or a write flushed everything — memory grew steadily between writes.
 * Three things now keep it bounded, and the first is the guarantee:
 *
 * 1. A hard entry cap, `REPORT_CACHE_MAX_ENTRIES` (default 500), enforced on
 *    every write by evicting the least-recently-used entry. The `Map`'s
 *    insertion order IS the recency order: a hit deletes and re-inserts its key,
 *    so the head of the map is always the LRU entry and eviction is O(1).
 * 2. A bounded expired-entry sweep on every write: at most `SWEEP_BATCH`
 *    entries are inspected from the LRU end, stopping at the first fresh one.
 *    It is approximate (a hit moves an entry to the tail without renewing its
 *    expiry), which is fine — it only exists to hand memory back early; the cap
 *    is what bounds it. Never a full scan per request.
 * 3. An expired entry found on lookup is deleted there and then.
 *
 * `0` or any invalid `REPORT_CACHE_MAX_ENTRIES` means the default, NOT
 * "unbounded" and NOT "disabled": `REPORT_CACHE_TTL_MS=0` is already the one
 * switch that disables caching, and an unbounded mode is exactly what this cap
 * exists to remove.
 *
 * **Invalidation also has to beat a load that is already in flight** — the same
 * bug `user-status.ts` documents. A loader that started before
 * `invalidateReportCache()` and finished after it used to publish its pre-write
 * result with a full fresh TTL, re-caching stale data for the whole window.
 * `generation` is stamped when a load starts and re-checked before publishing;
 * invalidation bumps it and drops `inflight`, so a request arriving after the
 * write starts a fresh load instead of joining the superseded one. Callers
 * already awaiting the superseded load still receive its value — that is what
 * they asked for before the write. Precondition, as there: call
 * `invalidateReportCache()` only AFTER the write has committed, never from
 * inside a transaction callback, or a load can start, read the old rows and
 * publish under the new generation.
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

/**
 * Default entry cap. One entry is one (report, company scope, filter set);
 * payloads are pre-aggregated (charts + KPIs + one page of rows, typically
 * 10–200 KB) with the occasional multi-MB export/roster payload, so 500 puts a
 * realistic ceiling around 100 MB per process. At the 30s TTL, holding 500
 * live keys takes ~17 distinct cache-filling requests per second sustained —
 * well above interactive load — so the cap only bites at scale or under abuse.
 */
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Maximum number of entries. Overridable via REPORT_CACHE_MAX_ENTRIES; only a
 * positive integer is accepted — unset, 0, negative, fractional or non-numeric
 * values all fall back to the default (never "unbounded").
 */
const MAX_ENTRIES = (() => {
  const raw = Number(process.env.REPORT_CACHE_MAX_ENTRIES);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_ENTRIES;
})();

/** How many LRU-end entries one write may inspect for expiry. Keeps writes O(1). */
const SWEEP_BATCH = 8;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/** Insertion order == recency order: the first key is the least recently used. */
const store = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Bumped by `invalidateReportCache()`. A load publishes its result only if this
 * is unchanged since the load started; see the module docstring.
 */
let generation = 0;

/**
 * Stable key fragment for a resolved company scope.
 * `null` = unrestricted (SuperAdmin, all companies); otherwise the sorted id
 * list so `[2,1]` and `[1,2]` collapse to the same key.
 */
export function scopeKey(scope: number[] | null): string {
  return scope === null ? "all" : [...scope].sort((a, b) => a - b).join(",");
}

/** Drop up to SWEEP_BATCH expired entries from the LRU end, stopping at the first fresh one. */
function sweepExpired(now: number): void {
  let inspected = 0;
  for (const [key, entry] of store) {
    if (inspected >= SWEEP_BATCH || entry.expiresAt > now) break;
    store.delete(key);
    inspected += 1;
  }
}

/** Store `value` as the most recently used entry, then enforce the cap. */
function publish(key: string, value: unknown): void {
  const now = Date.now();
  sweepExpired(now);
  store.delete(key); // re-insert at the tail even if the key already exists
  store.set(key, { value, expiresAt: now + TTL_MS });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
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
  if (hit) {
    if (hit.expiresAt > now) {
      // Refresh recency: move to the tail of the insertion order.
      store.delete(key);
      store.set(key, hit);
      return hit.value as T;
    }
    store.delete(key);
  }

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  // Stamped before the loader runs: an invalidation from here on supersedes it.
  const startedAt = generation;
  const promise: Promise<T> = (async () => {
    const value = await loader();
    if (generation === startedAt) publish(key, value);
    return value;
  })().finally(() => {
    // Only remove our OWN entry. After an invalidation a newer load may occupy
    // this key; deleting it unconditionally would evict that live load, and the
    // next caller would start a third load instead of joining the second.
    if (inflight.get(key) === promise) inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}

/**
 * Flush the entire cache. Called after any write that changes report inputs
 * (training-taken / student / training-data / program-data mutations, imports)
 * so the next read recomputes against fresh data. Loads already in flight are
 * superseded: they still resolve for the callers awaiting them, but they do not
 * publish, and a request arriving after this call starts a fresh load rather
 * than joining one that may have read the pre-write rows. Call it only after the
 * write has committed.
 */
export function invalidateReportCache(): void {
  generation += 1;
  store.clear();
  inflight.clear();
}
