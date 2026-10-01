"use client";

import { useEffect, useState } from "react";

/**
 * One region-data row — `{ country, region, theatre, isoCode }` (a.k.a.
 * CountryOption). `isoCode` is ISO 3166-1 alpha-2, uppercase, and `null` means
 * unmapped — a first-class state, never a stand-in for a guess. It is not
 * unique, so several rows may share one code and a consumer must aggregate.
 */
export interface RegionDataRow {
  country: string;
  region: string;
  theatre: string | null;
  isoCode: string | null;
}

// Module-level cache so the small, global region-data list is shared across
// every page that needs the theatre/region/country lists (student add/edit
// forms, the cascading report scope filters, the Country Set picker) and
// paints instantly on mount.
//
// It is **stale-while-revalidate**, not fetch-once. It used to be fetched once
// per session and never refreshed: client-side navigation keeps this module
// alive, so a country added on /admin/region-data stayed missing from every
// picker until a full page reload — which read as "the country is not there".
// Now every enabled mount serves the cached rows at once and refetches in the
// background (de-duplicated through `inflight`, so a page with several pickers
// still makes one request), and the Region Data page calls
// `invalidateRegionData()` after each write so open pickers update too.
//
// A failed fetch is never cached: it keeps the previous rows (or none) and the
// next mount retries. Caching `[]` on failure left every picker empty for the
// rest of the session after one network blip.
let cached: RegionDataRow[] | null = null;
let inflight: Promise<RegionDataRow[]> | null = null;
// Bumped by `invalidateRegionData()`. A fetch only publishes if no
// invalidation happened after it started — otherwise a response read before a
// write could land after it and put the stale list back.
let generation = 0;
const listeners = new Set<(rows: RegionDataRow[]) => void>();

function revalidate(): Promise<RegionDataRow[]> {
  if (inflight) return inflight;
  const startedAt = generation;
  const request: Promise<RegionDataRow[]> = fetch("/api/region-data/countries")
    .then((r) => {
      if (!r.ok) throw new Error(`region-data ${r.status}`);
      return r.json();
    })
    .then((rows: unknown) => {
      const next = Array.isArray(rows) ? (rows as RegionDataRow[]) : [];
      if (startedAt === generation) {
        cached = next;
        for (const listener of listeners) listener(next);
      }
      return next;
    })
    .catch(() => cached ?? [])
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

/**
 * Refetch the shared region-data list and push the result to every mounted
 * `useRegionData`. Call it after any write to Region Data, so a page already
 * holding the list (in this tab) sees the change without a reload.
 */
export function invalidateRegionData(): void {
  generation += 1;
  // Drop the superseded request so the refetch below actually starts; its
  // late result is ignored by the generation check.
  inflight = null;
  void revalidate();
}

/**
 * Returns the shared region-data rows (theatre/region/country): the cached list
 * at once, then a fresh one from a background refetch on every enabled mount.
 * Pass `enabled = false` to defer the fetch (e.g. a form that only needs the
 * list once it enters edit mode); the hook still receives any list another
 * caller loads. `loading` is true only while an enabled hook has no list yet.
 */
export function useRegionData(enabled = true): { rows: RegionDataRow[]; loading: boolean } {
  const [state, setState] = useState<{ rows: RegionDataRow[]; loaded: boolean }>(() =>
    cached ? { rows: cached, loaded: true } : { rows: [], loaded: false }
  );

  // Hear about every fresh list, enabled or not.
  useEffect(() => {
    const listener = (rows: RegionDataRow[]) => setState({ rows, loaded: true });
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // setState only inside the async callback keeps this clear of the
    // react-hooks/set-state-in-effect rule. The `.then` also covers a failed
    // first load (no list to publish), so `loading` still settles.
    revalidate().then((rows) => {
      // `cached` rather than `rows`: if an invalidation superseded this request,
      // its result is stale and the newer list (if any) is already cached.
      if (!cancelled) setState({ rows: cached ?? rows, loaded: true });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { rows: state.rows, loading: enabled && !state.loaded };
}
