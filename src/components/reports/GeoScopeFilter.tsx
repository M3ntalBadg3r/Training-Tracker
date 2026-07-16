"use client";

import { useMemo } from "react";
import { useRegionData } from "@/hooks/useRegionData";

export interface GeoScope {
  theatre: string;
  region: string;
  country: string;
}

export const EMPTY_GEO_SCOPE: GeoScope = { theatre: "", region: "", country: "" };

interface Props {
  value: GeoScope;
  onChange: (next: GeoScope) => void;
  /** Extra classes applied to each <select>. */
  selectClassName?: string;
}

/**
 * Shared cascading theatre → region → country scope filter for reports.
 *
 * Options are sourced from `useRegionData()` (session-cached). Region choices
 * are narrowed by the selected theatre; country choices by theatre AND region.
 * Changing an ancestor resets its descendants, mirroring the pattern the
 * renewal-forecast / program-compliance-trend reports established.
 */
export default function GeoScopeFilter({ value, onChange, selectClassName }: Props) {
  const { rows: regionRows } = useRegionData();
  const { theatre, region, country } = value;

  const theatreOptions = useMemo(
    () => [...new Set(regionRows.map((r) => r.theatre).filter((t): t is string => !!t))].sort(),
    [regionRows]
  );
  const regionOptions = useMemo(
    () =>
      [...new Set(
        regionRows
          .filter((r) => !theatre || r.theatre === theatre)
          .map((r) => r.region)
          .filter(Boolean)
      )].sort(),
    [regionRows, theatre]
  );
  const countryOptions = useMemo(
    () =>
      [...new Set(
        regionRows
          .filter((r) => (!theatre || r.theatre === theatre) && (!region || r.region === region))
          .map((r) => r.country)
      )].sort(),
    [regionRows, theatre, region]
  );

  const cls = selectClassName ?? "border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white";

  return (
    <>
      <select
        value={theatre}
        onChange={(e) => onChange({ theatre: e.target.value, region: "", country: "" })}
        className={cls}
      >
        <option value="">All Theatres</option>
        {theatreOptions.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <select
        value={region}
        onChange={(e) => onChange({ theatre, region: e.target.value, country: "" })}
        className={cls}
      >
        <option value="">All Regions</option>
        {regionOptions.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
      <select
        value={country}
        onChange={(e) => onChange({ theatre, region, country: e.target.value })}
        className={cls}
      >
        <option value="">All Countries</option>
        {countryOptions.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    </>
  );
}
