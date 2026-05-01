"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar as CalendarIcon, X } from "lucide-react";
import { DayPicker, DateRange } from "react-day-picker";
import "react-day-picker/style.css";

export interface DateRangeValue {
  from: Date | null;
  to: Date | null;
}

interface Props {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  placeholder?: string;
  className?: string;
}

const PRESETS: { label: string; range: () => DateRangeValue }[] = [
  {
    label: "Last 30 days",
    range: () => {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 30);
      return { from, to };
    },
  },
  {
    label: "Last 90 days",
    range: () => {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 90);
      return { from, to };
    },
  },
  {
    label: "Last 12 months",
    range: () => {
      const to = new Date();
      const from = new Date();
      from.setFullYear(from.getFullYear() - 1);
      return { from, to };
    },
  },
  {
    label: "Year to date",
    range: () => {
      const to = new Date();
      const from = new Date(to.getFullYear(), 0, 1);
      return { from, to };
    },
  },
  {
    label: "All time",
    range: () => ({ from: null, to: null }),
  },
];

function formatShort(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export default function DateRangePicker({ value, onChange, placeholder = "Date range", className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const label =
    value.from && value.to
      ? `${formatShort(value.from)} – ${formatShort(value.to)}`
      : value.from
      ? `From ${formatShort(value.from)}`
      : value.to
      ? `Until ${formatShort(value.to)}`
      : placeholder;

  const dpValue: DateRange | undefined =
    value.from || value.to ? { from: value.from ?? undefined, to: value.to ?? undefined } : undefined;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white text-gray-700 hover:border-gray-400"
      >
        <CalendarIcon size={14} className="text-gray-400" />
        <span className={value.from || value.to ? "" : "text-gray-400"}>{label}</span>
        {(value.from || value.to) && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onChange({ from: null, to: null });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onChange({ from: null, to: null });
              }
            }}
            className="ml-1 p-0.5 rounded hover:bg-gray-100 cursor-pointer"
          >
            <X size={12} />
          </span>
        )}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 right-0 bg-white border border-gray-200 rounded-lg shadow-lg p-3 flex gap-3">
          <div className="flex flex-col gap-1 border-r border-gray-200 pr-3 min-w-[140px]">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  onChange(p.range());
                  setOpen(false);
                }}
                className="text-left text-sm px-2 py-1 rounded hover:bg-gray-100 text-gray-700"
              >
                {p.label}
              </button>
            ))}
          </div>
          <DayPicker
            mode="range"
            selected={dpValue}
            onSelect={(r) =>
              onChange({
                from: r?.from ?? null,
                to: r?.to ?? null,
              })
            }
            numberOfMonths={2}
          />
        </div>
      )}
    </div>
  );
}

/** Apply a date range to a list of records, comparing one ISO date string field. */
export function filterByRange<T>(rows: T[], dateKey: keyof T, range: DateRangeValue): T[] {
  if (!range.from && !range.to) return rows;
  return rows.filter((r) => {
    const v = r[dateKey];
    if (typeof v !== "string") return true;
    const d = new Date(v);
    if (range.from && d < range.from) return false;
    if (range.to) {
      const endOfDay = new Date(range.to);
      endOfDay.setHours(23, 59, 59, 999);
      if (d > endOfDay) return false;
    }
    return true;
  });
}
