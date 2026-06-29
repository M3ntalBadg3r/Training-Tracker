"use client";

import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

/** Extracts the comparable value for a given column from a row. */
export type SortAccessor<T> = (row: T) => string | number | boolean | null | undefined;

interface UseTableSortOptions {
  /** Column key to sort by on first render. */
  defaultKey?: string;
  /** Direction to sort by on first render (default "asc"). */
  defaultDir?: SortDir;
  /**
   * Column key used as a stable tiebreaker when the active column compares
   * equal. Defaults to `defaultKey`. Always compared ascending.
   */
  tiebreakKey?: string;
  /**
   * Column keys that should default to descending when first selected
   * (e.g. numeric "score" columns where users expect highest-first).
   */
  descFirstKeys?: string[];
}

export interface UseTableSortResult<T> {
  /** Rows sorted by the current key/direction. */
  sorted: T[];
  sortKey: string;
  sortDir: SortDir;
  /** Click handler: same key flips direction, a new key selects it. */
  toggleSort: (key: string) => void;
  /** Returns " ▲" / " ▼" for the active column, "" otherwise. */
  sortIndicator: (key: string) => string;
}

function isEmpty(v: string | number | boolean | null | undefined): boolean {
  return v === null || v === undefined || v === "";
}

function compare(
  a: string | number | boolean | null | undefined,
  b: string | number | boolean | null | undefined,
): number {
  // Empty values always sort last, regardless of direction.
  const ae = isEmpty(a);
  const be = isEmpty(b);
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;

  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" || typeof b === "boolean") {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * Generic, reusable table sorting hook shared by the report pages.
 *
 * Pass the rows to display and an `accessors` map (column key -> value getter).
 * Render each sortable `<th>` with `onClick={() => toggleSort(key)}` and append
 * `{sortIndicator(key)}` to its label. Feed `sorted` (not the raw rows) into the
 * table body / grouping helper.
 *
 * Empty/null values always sort last. Numbers and booleans compare numerically;
 * strings use a numeric-aware locale compare. A stable tiebreak keeps ordering
 * deterministic when the active column ties.
 */
export function useTableSort<T>(
  rows: T[],
  accessors: Record<string, SortAccessor<T>>,
  opts: UseTableSortOptions = {},
): UseTableSortResult<T> {
  const { defaultKey = "", defaultDir = "asc", descFirstKeys = [] } = opts;
  const tiebreakKey = opts.tiebreakKey ?? defaultKey;

  const [sortKey, setSortKey] = useState<string>(defaultKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir);

  const sorted = useMemo(() => {
    const active = accessors[sortKey];
    if (!active) return rows;
    const tiebreak = tiebreakKey ? accessors[tiebreakKey] : undefined;
    const arr = [...rows];
    arr.sort((a, b) => {
      const primary = compare(active(a), active(b));
      const signed = sortDir === "asc" ? primary : -primary;
      if (signed !== 0) return signed;
      if (tiebreak && tiebreakKey !== sortKey) {
        return compare(tiebreak(a), tiebreak(b)); // tiebreak always ascending
      }
      return 0;
    });
    return arr;
  }, [rows, accessors, sortKey, sortDir, tiebreakKey]);

  function toggleSort(key: string) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(descFirstKeys.includes(key) ? "desc" : "asc");
    }
  }

  const sortIndicator = (key: string) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  return { sorted, sortKey, sortDir, toggleSort, sortIndicator };
}

export default useTableSort;
