"use client";

import { useMemo } from "react";
import { useRegionData } from "@/hooks/useRegionData";

/**
 * The two anchored-program settings, shared by the New Program modal and the
 * program page's settings card so they read (and validate) the same:
 *  - **Anchor theatre** — when set, the program is judged over two populations
 *    at once: its Theatre requirements across this theatre, and its Country Set
 *    requirements over each partner's own target countries inside it.
 *  - **Default minimum target countries** — how many target countries a
 *    partner must name, unless their own partner settings say otherwise.
 *
 * `minimum` is kept as the raw input text so a half-typed value is not coerced;
 * the server parses it strictly (a whole number 1–1000, blank = none).
 */
export interface AnchorSettingsValue {
  anchorTheatre: string;
  minimum: string;
}

export function useTheatreOptions(extra?: string | null): string[] {
  const { rows } = useRegionData();
  return useMemo(() => {
    const set = new Set(rows.map((r) => r.theatre?.trim() ?? "").filter(Boolean));
    // Keep a stored anchor visible even if Region Data no longer lists it.
    if (extra && extra.trim()) set.add(extra.trim());
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows, extra]);
}

export default function AnchorSettingsFields({
  value,
  onChange,
  idPrefix,
}: {
  value: AnchorSettingsValue;
  onChange: (next: AnchorSettingsValue) => void;
  idPrefix: string;
}) {
  const theatres = useTheatreOptions(value.anchorTheatre);
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-anchor`} className="block text-sm font-medium mb-1">
          Anchor theatre
        </label>
        <select
          id={`${idPrefix}-anchor`}
          value={value.anchorTheatre}
          onChange={(e) => onChange({ ...value, anchorTheatre: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
        >
          <option value="">None — an ordinary program</option>
          {theatres.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-500">
          When set, Theatre requirements count across this theatre and Country Set requirements count over each
          partner&apos;s own target countries in it, both in one view.
        </p>
      </div>
      {value.anchorTheatre && (
        <div>
          <label htmlFor={`${idPrefix}-minimum`} className="block text-sm font-medium mb-1">
            Default minimum target countries <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
            id={`${idPrefix}-minimum`}
            type="number"
            min={1}
            max={1000}
            step={1}
            value={value.minimum}
            onChange={(e) => onChange({ ...value, minimum: e.target.value })}
            placeholder="No minimum"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            How many target countries a partner must name before any tier is reached, unless their partner settings
            give their own number.
          </p>
        </div>
      )}
    </div>
  );
}
