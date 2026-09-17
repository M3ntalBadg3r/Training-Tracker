"use client";

import { useMemo, useState } from "react";
import SearchInput from "@/components/ui/FormControls";

/**
 * Pick one or more trainings by Full Title.
 *
 * Every relationship in the catalogue — "leads to Certification", "replaced by",
 * OLX membership — points at a training. The pickers this replaces listed raw
 * `trainingTitle`s while *labelling* each row with its Full Title, so a training
 * that arrived under three import spellings appeared three times with identical
 * text and the admin had to guess which to tick. Worse, ticking one of three
 * meant the relationship only pointed at one spelling.
 *
 * So the value here is a list of Full Titles, and the server expands it to the
 * underlying training titles. That is the pattern the legacy "Replaced by"
 * control already used; this generalises it and adds a search box, because a
 * real catalogue does not fit in an unfiltered scroll box.
 */

export interface FullTitleOption {
  fullTitle: string;
  trainingTypes?: string[];
  memberCount?: number;
}

const TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
  InstructorLedTraining: "Instructor-Led Training",
  OLX: "OLX",
  OLXSubItem: "OLX Sub-Item",
};

export default function FullTitlePicker({
  options,
  value,
  onChange,
  multiple = true,
  searchPlaceholder = "Search Full Titles…",
  emptyMessage = "Nothing available to choose.",
  disabledFullTitles = [],
  maxHeight = "14rem",
}: {
  options: FullTitleOption[];
  value: string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabledFullTitles?: string[];
  maxHeight?: string;
}) {
  const [query, setQuery] = useState("");

  const disabled = useMemo(() => new Set(disabledFullTitles), [disabledFullTitles]);
  const selected = useMemo(() => new Set(value), [value]);

  // A selected row stays visible while you type, pinned above the matches.
  // Without this, narrowing the search hides what you already picked, which
  // reads as "my selection was cleared".
  const { pinned, rest } = useMemo(() => {
    const term = query.trim().toLowerCase();
    const visible = options.filter((o) => !disabled.has(o.fullTitle));
    const matches = term
      ? visible.filter((o) => o.fullTitle.toLowerCase().includes(term))
      : visible;
    const matchSet = new Set(matches.map((o) => o.fullTitle));
    return {
      pinned: visible.filter((o) => selected.has(o.fullTitle) && !matchSet.has(o.fullTitle)),
      rest: matches,
    };
  }, [options, query, disabled, selected]);

  const toggle = (fullTitle: string, checked: boolean) => {
    if (!multiple) {
      onChange(checked ? [fullTitle] : []);
      return;
    }
    onChange(checked ? [...value, fullTitle] : value.filter((v) => v !== fullTitle));
  };

  const rows = [...pinned, ...rest];
  const total = options.filter((o) => !disabled.has(o.fullTitle)).length;

  if (total === 0) {
    return <p className="text-xs text-gray-400">{emptyMessage}</p>;
  }

  return (
    <div className="max-w-md">
      {total > 8 && (
        <div className="mb-2">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={searchPlaceholder}
            className="w-full"
          />
        </div>
      )}
      <div
        className="overflow-y-auto border border-gray-200 rounded-lg px-2 py-1 bg-white space-y-0.5"
        style={{ maxHeight }}
      >
        {rows.length === 0 ? (
          <p className="text-xs text-gray-400 py-1 px-1">No Full Title matches that search.</p>
        ) : (
          rows.map((o) => {
            const types = (o.trainingTypes ?? [])
              .map((t) => TYPE_LABELS[t] ?? t)
              .join(", ");
            return (
              <label
                key={o.fullTitle}
                className="flex items-start gap-2 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5"
              >
                <input
                  type={multiple ? "checkbox" : "radio"}
                  checked={selected.has(o.fullTitle)}
                  onChange={(e) => toggle(o.fullTitle, e.target.checked)}
                  className="rounded border-gray-300 mt-0.5"
                />
                <span className="min-w-0">
                  <span className="text-xs text-gray-800 block break-words">{o.fullTitle}</span>
                  {(types || (o.memberCount ?? 0) > 1) && (
                    <span className="text-[11px] text-gray-400 block">
                      {types}
                      {types && (o.memberCount ?? 0) > 1 ? " · " : ""}
                      {(o.memberCount ?? 0) > 1 ? `${o.memberCount} training titles` : ""}
                    </span>
                  )}
                </span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
