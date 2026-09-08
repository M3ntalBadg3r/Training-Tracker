"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a PDF export should embed the page's charts.
 *
 * Defaults to on — a PDF is a presentation format, so charts are usually what
 * the user wants — and remembers the choice per browser. Follows the same
 * external-store shape as `ThemeProvider`, so several export menus (and any
 * future settings toggle) stay in step without prop drilling.
 */
const STORAGE_KEY = "tt.exportIncludeCharts";
const CHANGE_EVENT = "tt-include-charts-change";

function subscribe(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

/** Only an explicit "false" turns it off, so an unset key means on. */
function getSnapshot(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true; // private mode / storage blocked
  }
}

/** Matches the client default, so nothing changes between SSR and hydration. */
function getServerSnapshot(): boolean {
  return true;
}

export function useIncludeCharts(): [boolean, (value: boolean) => void] {
  const includeCharts = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setIncludeCharts = useCallback((value: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Preference simply won't persist; the menu still works this session.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [includeCharts, setIncludeCharts];
}
