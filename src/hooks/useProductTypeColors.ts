"use client";

import { useEffect, useState } from "react";

type ColorMap = Record<string, string | null>;

// Module-level cache so navigating between chart pages doesn't refetch the
// (tiny) product-type colour list every time. Charts use this map to look up
// each product's brand colour via chart.productColor().
let cached: ColorMap | null = null;
let inflight: Promise<ColorMap> | null = null;

async function loadColors(): Promise<ColorMap> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = fetch("/api/product-types")
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: { name: string; color: string | null }[]) => {
      const map: ColorMap = {};
      for (const r of rows) map[r.name] = r.color;
      cached = map;
      return map;
    })
    .catch(() => ({}))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Returns a `{ name -> hex | null }` lookup for every configured product
 * type. Fetched once per page load and cached for the rest of the session.
 */
export function useProductTypeColors(): ColorMap {
  const [map, setMap] = useState<ColorMap>(() => cached ?? {});
  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    loadColors().then((next) => {
      if (!cancelled) setMap(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return map;
}
