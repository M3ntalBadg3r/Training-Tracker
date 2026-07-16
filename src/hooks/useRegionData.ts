"use client";

import { useEffect, useState } from "react";

/** One region-data row — `{ country, region, theatre }` (a.k.a. CountryOption). */
export interface RegionDataRow {
  country: string;
  region: string;
  theatre: string | null;
}

// Module-level cache so the small, global region-data list is fetched once per
// session and shared across every page that needs the theatre/region/country
// lists (student add/edit forms + the cascading report scope filters), rather
// than each page re-hitting /api/region-data/countries on mount. Mirrors the
// pattern in useProductTypeColors.ts.
let cached: RegionDataRow[] | null = null;
let inflight: Promise<RegionDataRow[]> | null = null;

async function load(): Promise<RegionDataRow[]> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = fetch("/api/region-data/countries")
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: RegionDataRow[]) => {
      cached = Array.isArray(rows) ? rows : [];
      return cached;
    })
    .catch(() => {
      cached = [];
      return cached;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Returns the shared region-data rows (theatre/region/country), fetched once and
 * cached for the session. Pass `enabled = false` to defer the fetch (e.g. a form
 * that only needs the list once it enters edit mode); the list still comes from
 * the shared cache once loaded. `loading` is true only while an enabled fetch is
 * outstanding.
 */
export function useRegionData(enabled = true): { rows: RegionDataRow[]; loading: boolean } {
  const [state, setState] = useState<{ rows: RegionDataRow[]; loaded: boolean }>(() =>
    cached ? { rows: cached, loaded: true } : { rows: [], loaded: false }
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // setState only inside the async callback keeps this clear of the
    // react-hooks/set-state-in-effect rule.
    load().then((rows) => {
      if (!cancelled) setState({ rows, loaded: true });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { rows: state.rows, loading: enabled && !state.loaded };
}
