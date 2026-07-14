"use client";

import { useEffect, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { X } from "lucide-react";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

interface HexColorPickerFieldProps {
  value: string | null;
  onChange: (value: string | null) => void;
  /** Optional placeholder text shown in the swatch when no colour is set. */
  emptyLabel?: string;
}

export default function HexColorPickerField({ value, onChange, emptyLabel = "No colour" }: HexColorPickerFieldProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value ?? "");
  const [syncedValue, setSyncedValue] = useState(value ?? "");
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the text input in sync when the parent value changes. Done during
  // render (React's "adjust state while rendering" pattern) rather than in an
  // effect.
  if (syncedValue !== (value ?? "")) {
    setText(value ?? "");
    setSyncedValue(value ?? "");
  }

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const textIsValid = !text || HEX_RE.test(text);
  const swatchColor = value ?? "transparent";

  const handlePickerChange = (next: string) => {
    const lower = next.toLowerCase();
    setText(lower);
    onChange(lower);
  };

  const handleTextChange = (next: string) => {
    // Auto-prepend # if the user types 6 hex chars without it.
    let normalised = next.trim();
    if (normalised && !normalised.startsWith("#")) normalised = `#${normalised}`;
    setText(normalised);
    if (!normalised) {
      onChange(null);
    } else if (HEX_RE.test(normalised)) {
      onChange(normalised.toLowerCase());
    }
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="h-8 w-10 rounded-lg border border-gray-300 flex items-center justify-center overflow-hidden"
          style={value ? { backgroundColor: swatchColor } : undefined}
          aria-label="Pick colour"
        >
          {!value && (
            <span className="block w-full h-full bg-[repeating-conic-gradient(#e5e7eb_0_25%,#ffffff_0_50%)] bg-[length:12px_12px]" />
          )}
        </button>
        <input
          type="text"
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          placeholder={emptyLabel}
          maxLength={7}
          className={`w-28 px-2 py-1.5 border rounded-lg text-sm font-mono ${textIsValid ? "border-gray-300" : "border-red-400 text-red-600"}`}
        />
        {value && (
          <button
            type="button"
            onClick={() => { onChange(null); setText(""); }}
            className="p-1 text-gray-400 hover:text-gray-600"
            title="Clear colour"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {open && (
        <div className="absolute z-50 mt-2 p-3 bg-white border border-gray-200 rounded-lg shadow-lg">
          <HexColorPicker color={value ?? "#3b82f6"} onChange={handlePickerChange} />
        </div>
      )}
    </div>
  );
}
