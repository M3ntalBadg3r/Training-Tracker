"use client";

import { Search } from "lucide-react";

/**
 * The shared form-control class strings.
 *
 * These are exported as constants rather than wrapped in `<Select>`/`<Input>`
 * components on purpose: the call sites pass wildly different children (option
 * lists built five ways), and a wrapper that forwards every native prop earns
 * nothing over a shared string. What the app actually lacked was *one* string.
 *
 * Before this there were 29 distinct `<select>` and 31 distinct non-checkbox
 * `<input>` class strings across `src/app`, many of them byte-different but
 * pixel-identical — `w-full px-3 py-2 border…` and `w-full border…px-3 py-2`
 * alone accounted for 43 instances of one control written two ways.
 */
export const SELECT_CLASS =
  "border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white";

export const INPUT_CLASS =
  "border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white";

export const CHECKBOX_LABEL_CLASS =
  "flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none";

/**
 * The icon + grow search box the report pages use.
 *
 * The report copies had drifted from `DataTable`'s original by dropping its
 * focus ring, which left the same field in four forms. This restores it, so
 * keyboard focus is visible wherever the control appears.
 */
export default function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className || "flex-1 min-w-[200px]"}`}>
      <Search
        size={16}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
    </div>
  );
}
