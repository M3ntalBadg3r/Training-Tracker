"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import SearchInput from "@/components/ui/FormControls";
import type { CompanyPickerOption } from "@/components/company/CompanyPicker";

/**
 * Pick any number of companies, by search.
 *
 * Replaces the unfiltered checkbox scroll boxes on the user and API-key forms,
 * which mounted one checkbox per company — tens of thousands for a SuperAdmin
 * on a large install, where finding a company meant scrolling for it and
 * seeing what was already ticked meant scrolling for that too.
 *
 * Same shape as `components/training/FullTitlePicker.tsx`: what is selected is
 * stated above the list as removable chips; selected rows stay pinned above the
 * matches while you type, because narrowing the search otherwise reads as "my
 * selection was cleared"; and the search box only appears once the list is long
 * enough to need one. On top of that, at most `maxResults` unselected matches
 * are mounted, with a count of the rest.
 */
export default function CompanyMultiPicker({
  options,
  value,
  onChange,
  label = "Companies",
  emptyMessage = "No companies exist.",
  helpText,
  searchPlaceholder = "Search companies…",
  maxResults = 50,
  disabled = false,
}: {
  options: CompanyPickerOption[];
  value: number[];
  onChange: (next: number[]) => void;
  label?: string;
  emptyMessage?: string;
  helpText?: string;
  searchPlaceholder?: string;
  maxResults?: number;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");

  const selected = useMemo(() => new Set(value), [value]);
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o.name])), [options]);
  const haystack = useMemo(
    () => options.map((o) => ({ id: o.id, name: o.name, lower: o.name.toLowerCase() })),
    [options]
  );

  const { pinned, matches, more } = useMemo(() => {
    const term = query.trim().toLowerCase();
    const pinnedRows: CompanyPickerOption[] = [];
    const matchRows: CompanyPickerOption[] = [];
    let unselectedMatched = 0;
    for (const o of haystack) {
      const hit = !term || o.lower.includes(term);
      if (selected.has(o.id)) {
        // Selected companies are always listed: in the matches when they match,
        // pinned above them when they do not.
        (hit ? matchRows : pinnedRows).push(o);
        continue;
      }
      if (!hit) continue;
      unselectedMatched++;
      if (unselectedMatched <= maxResults) matchRows.push(o);
    }
    return { pinned: pinnedRows, matches: matchRows, more: Math.max(0, unselectedMatched - maxResults) };
  }, [query, haystack, selected, maxResults]);

  const toggle = (id: number, checked: boolean) => {
    onChange(checked ? [...value, id] : value.filter((v) => v !== id));
  };

  const rows = [...pinned, ...matches];

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {options.length === 0 ? (
        <p className="text-xs text-gray-500">{emptyMessage}</p>
      ) : (
        <>
          {value.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {value.map((id) => {
                // An id the list does not hold still shows, so a selection is
                // never silently dropped from view.
                const name = byId.get(id) ?? `#${id}`;
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 pl-2.5 pr-1 py-0.5 text-xs text-blue-800"
                  >
                    <span className="break-words">{name}</span>
                    <button
                      type="button"
                      onClick={() => onChange(value.filter((v) => v !== id))}
                      disabled={disabled}
                      aria-label={`Remove ${name}`}
                      title={`Remove ${name}`}
                      className="rounded-full p-0.5 text-blue-500 hover:bg-blue-100 hover:text-blue-800"
                    >
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
              {value.length > 1 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  disabled={disabled}
                  className="text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2 ml-0.5"
                >
                  Clear all
                </button>
              )}
            </div>
          )}
          {options.length > 8 && (
            <div className="mb-2">
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder={searchPlaceholder}
                className="w-full"
              />
            </div>
          )}
          <div className="border border-gray-300 rounded-lg p-2 max-h-48 overflow-y-auto space-y-1 bg-white">
            {rows.length === 0 ? (
              <p className="text-xs text-gray-400 px-1">No companies match that search.</p>
            ) : (
              rows.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={(e) => toggle(c.id, e.target.checked)}
                    disabled={disabled}
                  />
                  <span className="min-w-0 break-words">{c.name}</span>
                </label>
              ))
            )}
            {rows.length > 0 && matches.length === 0 && (
              // Only the pinned selection is showing: say the search found nothing
              // else, rather than leaving it to look like a complete list.
              <p className="text-xs text-gray-400 px-1 pt-1">No other companies match that search.</p>
            )}
            {more > 0 && (
              <p className="text-xs text-gray-500 px-1 pt-1 border-t border-gray-100">
                {more.toLocaleString()} more — keep typing to narrow the list.
              </p>
            )}
          </div>
        </>
      )}
      {helpText && <p className="text-xs text-gray-400 mt-1">{helpText}</p>}
    </div>
  );
}
