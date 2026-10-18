"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { INPUT_CLASS } from "@/components/ui/FormControls";

/**
 * Pick one company, by typing part of its name.
 *
 * This replaces the plain `<select>` every company field used to be. A select
 * is fine for the one-to-twenty companies a typical user holds, and unusable for
 * a SuperAdmin on an install with tens of thousands: the browser has to mount
 * every `<option>`, and finding one means scrolling a list nobody can scroll.
 * Server speed does not help with that, so the fix belongs in the control.
 *
 * Filtering is a case-insensitive substring match done in the browser over the
 * list the caller already holds, and at most `maxResults` rows are ever
 * mounted. Past that cap the list says how many more there are, so a truncated
 * list never passes for a complete one.
 *
 * The value is either a company id, the `"all"` sentinel (only when
 * `allOption` is set — the header switcher), or `null` for nothing chosen.
 * `clearable` adds a row that chooses `null`, standing in for the
 * `<option value="">-- Select a company --</option>` the old selects carried.
 */

export interface CompanyPickerOption {
  id: number;
  name: string;
}

export type CompanyPickerValue = number | "all" | null;

type Row =
  | { kind: "clear"; key: string; label: string }
  | { kind: "all"; key: string; label: string }
  | { kind: "company"; key: string; label: string; id: number };

export default function CompanyPicker({
  options,
  value,
  onChange,
  allOption = false,
  allLabel = "All companies",
  placeholder = "Select a company…",
  clearable = false,
  required = false,
  disabled = false,
  id,
  "aria-label": ariaLabel,
  title,
  className = "w-full",
  inputClassName,
  maxResults = 50,
}: {
  options: CompanyPickerOption[];
  value: CompanyPickerValue;
  onChange: (next: CompanyPickerValue) => void;
  /** Offer the "All companies" sentinel (header switcher only). */
  allOption?: boolean;
  allLabel?: string;
  /** Shown in the empty input when nothing is chosen, and as the clear row's label. */
  placeholder?: string;
  /** Add a row that chooses `null` (the old `<option value="">`). */
  clearable?: boolean;
  required?: boolean;
  disabled?: boolean;
  /** Put on the text input, so an existing `<label htmlFor>` still points at it. */
  id?: string;
  "aria-label"?: string;
  title?: string;
  /** Applied to the wrapper — use it for width (`w-full`, `md:w-1/2`, `flex-1 min-w-0`). */
  className?: string;
  /** Replaces the default input styling. */
  inputClassName?: string;
  maxResults?: number;
}) {
  const generatedId = useId();
  const inputId = id ?? `company-picker-${generatedId}`;
  const listboxId = `${inputId}-listbox`;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [open, setOpen] = useState(false);
  // `null` while the user is not typing: the input then shows the selection's
  // label. Kept separate so the input can never display a value that is not the
  // state once the user stops editing.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const selectedLabel = useMemo(() => {
    if (value === "all") return allOption ? allLabel : "";
    if (value === null) return "";
    return options.find((o) => o.id === value)?.name ?? "";
  }, [value, options, allOption, allLabel]);

  // Lower-case every name once per options list, not once per keystroke — at
  // 30,000 companies that is the difference between a responsive box and one
  // that stutters as you type.
  const haystack = useMemo(
    () => options.map((o) => ({ id: o.id, name: o.name, lower: o.name.toLowerCase() })),
    [options]
  );

  const { rows, more } = useMemo(() => {
    const term = (query ?? "").trim().toLowerCase();
    const out: Row[] = [];
    if (clearable && (!term || placeholder.toLowerCase().includes(term))) {
      out.push({ kind: "clear", key: "__clear", label: placeholder });
    }
    if (allOption && (!term || allLabel.toLowerCase().includes(term))) {
      out.push({ kind: "all", key: "__all", label: allLabel });
    }
    let matched = 0;
    for (const o of haystack) {
      if (term && !o.lower.includes(term)) continue;
      matched++;
      if (matched <= maxResults) out.push({ kind: "company", key: String(o.id), label: o.name, id: o.id });
    }
    return { rows: out, more: Math.max(0, matched - maxResults) };
  }, [query, haystack, clearable, placeholder, allOption, allLabel, maxResults]);

  const isSelected = (row: Row) =>
    row.kind === "company" ? value === row.id : row.kind === "all" ? value === "all" : value === null;

  const openList = () => {
    if (disabled) return;
    if (!open) {
      // Start on the current selection, so arrowing moves from where you are.
      const idx = rows.findIndex(isSelected);
      setActive(idx >= 0 ? idx : 0);
    }
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setQuery(null);
  };

  const choose = (row: Row) => {
    const next: CompanyPickerValue =
      row.kind === "company" ? row.id : row.kind === "all" ? "all" : null;
    if (next !== value) onChange(next);
    close();
  };

  // Close on a click anywhere outside the control.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the keyboard-active row in view.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) return openList();
        setActive((i) => Math.min(rows.length - 1, i + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        if (!open) return openList();
        setActive((i) => Math.max(0, i - 1));
        return;
      case "Home":
        if (open) { e.preventDefault(); setActive(0); }
        return;
      case "End":
        if (open) { e.preventDefault(); setActive(Math.max(0, rows.length - 1)); }
        return;
      case "Enter":
        if (open) {
          e.preventDefault();
          const row = rows[active];
          if (row) choose(row);
        } else {
          e.preventDefault();
          openList();
        }
        return;
      case "Escape":
        if (open) { e.preventDefault(); close(); }
        return;
      case "Tab":
        if (open) close();
        return;
    }
  };

  const activeRow = open ? rows[active] : undefined;
  const activeId = activeRow ? `${inputId}-opt-${activeRow.key}` : undefined;
  const display = query ?? selectedLabel;

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label={ariaLabel}
        aria-required={required || undefined}
        title={title}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        required={required}
        value={display}
        placeholder={allOption && value === "all" ? allLabel : placeholder}
        onFocus={(e) => {
          e.currentTarget.select();
          openList();
        }}
        onClick={openList}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          if (!open) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Leaving with half-typed text reverts to the selection rather than
          // keeping text that names nothing. The outside-click handler covers
          // mouse dismissal; this covers focus moving away by any other route.
          setQuery(null);
        }}
        className={
          inputClassName ??
          `${INPUT_CLASS} w-full pr-8 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed`
        }
      />
      <ChevronDown
        size={16}
        aria-hidden="true"
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
      />
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[12rem] rounded-lg border border-gray-200 bg-white shadow-lg">
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel ?? "Companies"}
            className="max-h-64 overflow-y-auto py-1"
          >
            {rows.map((row, idx) => {
              const selected = isSelected(row);
              return (
                <li
                  key={row.key}
                  id={`${inputId}-opt-${row.key}`}
                  data-index={idx}
                  role="option"
                  aria-selected={selected}
                  // mousedown, not click: picking must not blur the input first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(row);
                  }}
                  onMouseEnter={() => setActive(idx)}
                  className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer ${
                    idx === active ? "bg-blue-50 text-gray-900" : "text-gray-800"
                  } ${row.kind === "company" ? "" : "italic text-gray-500"}`}
                >
                  <span className="w-4 shrink-0">
                    {selected && <Check size={14} className="text-blue-600" aria-hidden="true" />}
                  </span>
                  <span className="min-w-0 break-words">{row.label}</span>
                </li>
              );
            })}
          </ul>
          {rows.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-400">No companies match that search.</p>
          )}
          {more > 0 && (
            <p className="border-t border-gray-100 px-3 py-1.5 text-xs text-gray-500" aria-live="polite">
              {more.toLocaleString()} more — keep typing to narrow the list.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
