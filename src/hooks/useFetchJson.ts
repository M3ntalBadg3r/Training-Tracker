"use client";

import { useCallback, useEffect, useState } from "react";

interface UseFetchJsonOptions {
  /**
   * When false the fetch is skipped and `loading` stays true — use it to gate on
   * something that must resolve first (e.g. `!companyScope.loading`, or a panel
   * being expanded).
   */
  enabled?: boolean;
}

interface UseFetchJsonResult<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  /** Force a refetch of the current url (e.g. after a mutation). */
  reload: () => void;
}

// Sentinels that can never collide with a real request key.
const INIT_KEY = "__init__";
const DISABLED_KEY = "__disabled__";

/**
 * Fetch JSON from `url` and return `{ data, loading, error, reload }`.
 *
 * `loading` is **derived** (`loadedKey !== requestKey`) rather than written with a
 * synchronous `setState` inside the effect, so a re-fetch (url/enabled/reload
 * change) shows the loading state again without tripping
 * `react-hooks/set-state-in-effect`. State is only ever written from inside the
 * async fetch continuation. On dep change the request key changes and `loading`
 * flips back to true via derivation, so the loading UX matches the old
 * `setLoading(true)`-before-fetch idiom exactly.
 *
 * Passing `url = null` (or `enabled: false`) keeps the hook in its loading state
 * without issuing a request.
 */
export function useFetchJson<T>(
  url: string | null,
  options: UseFetchJsonOptions = {}
): UseFetchJsonResult<T> {
  const { enabled = true } = options;
  const active = enabled && url !== null;
  const [reloadToken, setReloadToken] = useState(0);
  const requestKey = `${active ? (url as string) : DISABLED_KEY}#${reloadToken}`;

  const [state, setState] = useState<{ loadedKey: string; data: T | null; error: boolean }>({
    loadedKey: INIT_KEY,
    data: null,
    error: false,
  });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetch(url as string)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: T) => {
        if (!cancelled) setState({ loadedKey: requestKey, data, error: false });
      })
      .catch(() => {
        if (!cancelled) setState((prev) => ({ ...prev, loadedKey: requestKey, error: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, active, url]);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  return {
    data: state.data,
    loading: state.loadedKey !== requestKey,
    error: state.error,
    reload,
  };
}
