"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar as CalendarIcon, X } from "lucide-react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";
import { formatDateWith, parseDateWith, toIsoDate } from "@/lib/date-format";

interface Props {
  /** ISO yyyy-mm-dd. Empty string means no date selected. */
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  min?: Date;
  max?: Date;
  id?: string;
}

function isoToDate(iso: string): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isFinite(d.getTime()) ? d : null;
}

export default function DatePicker({
  value,
  onChange,
  placeholder,
  className = "",
  disabled = false,
  min,
  max,
  id,
}: Props) {
  const { format } = useDateFormat();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep the visible text in sync with the bound ISO value whenever either
  // the value or the user's format changes.
  useEffect(() => {
    const d = isoToDate(value);
    setText(d ? formatDateWith(d, format) : "");
    setError(false);
  }, [value, format]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const selectedDate = useMemo(() => isoToDate(value) ?? undefined, [value]);

  const commitText = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setError(false);
      onChange("");
      return;
    }
    const parsed = parseDateWith(trimmed, format);
    if (!parsed) {
      setError(true);
      return;
    }
    setError(false);
    onChange(toIsoDate(parsed));
  };

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <div
        className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm bg-white ${
          error ? "border-red-400" : "border-gray-300"
        } ${disabled ? "bg-gray-50 text-gray-400" : ""}`}
      >
        <CalendarIcon size={14} className="text-gray-400 shrink-0" />
        <input
          id={id}
          type="text"
          inputMode="numeric"
          value={text}
          placeholder={placeholder ?? format.toLowerCase()}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commitText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitText(text);
              setOpen(false);
            }
          }}
          disabled={disabled}
          className="flex-1 min-w-0 outline-none bg-transparent disabled:cursor-not-allowed"
        />
        {value && !disabled && (
          <button
            type="button"
            onClick={() => {
              onChange("");
              setText("");
              setError(false);
            }}
            className="p-0.5 rounded hover:bg-gray-100"
            title="Clear date"
          >
            <X size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={() => !disabled && setOpen((o) => !o)}
          disabled={disabled}
          className="text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed"
          title="Open calendar"
        >
          <CalendarIcon size={14} />
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-600 mt-1">Date doesn&apos;t match {format}.</p>
      )}
      {open && (
        <div className="absolute z-40 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2">
          <DayPicker
            mode="single"
            selected={selectedDate}
            onSelect={(d) => {
              if (d) {
                onChange(toIsoDate(d));
                setOpen(false);
              }
            }}
            disabled={(d) => {
              if (min && d < min) return true;
              if (max && d > max) return true;
              return false;
            }}
            defaultMonth={selectedDate ?? new Date()}
          />
        </div>
      )}
    </div>
  );
}
