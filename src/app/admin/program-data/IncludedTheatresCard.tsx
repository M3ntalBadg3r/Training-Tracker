"use client";

import { useMemo, useState } from "react";
import { Globe, Save } from "lucide-react";
import { useRegionData } from "@/hooks/useRegionData";

/**
 * The "Theatres included" card on a program's admin page: which theatres the
 * program operates in (`Program.includedTheatres`). Nothing ticked means every
 * theatre, so a program that never sets it behaves as it always has.
 *
 * The options are the theatres configured in Region Data, so a theatre added
 * there appears here with no code change. A stored theatre that has since left
 * Region Data is still listed (marked) so it can be unticked rather than
 * lingering invisibly in the saved list.
 */
export default function IncludedTheatresCard({
  programName,
  included,
  onSaved,
}: {
  programName: string;
  /** The stored list; null while the program has not loaded. */
  included: string[] | null;
  onSaved: (theatres: string[]) => void;
}) {
  const { rows: regionRows } = useRegionData();
  const known = useMemo(
    () => [...new Set(regionRows.map((r) => r.theatre).filter((t): t is string => !!t))].sort(),
    [regionRows]
  );

  // Seeded from the stored list, editable afterwards — the "adjust state while
  // rendering" pattern, so a reload of the stored value resets the form.
  const [selected, setSelected] = useState<string[]>(included ?? []);
  const [seed, setSeed] = useState<string[] | null>(included);
  if (included !== seed) {
    setSeed(included);
    setSelected(included ?? []);
  }

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const options = [...known, ...selected.filter((t) => !known.includes(t))];

  const toggle = (theatre: string) => {
    setSaved(false);
    setSelected((prev) => (prev.includes(theatre) ? prev.filter((t) => t !== theatre) : [...prev, theatre]));
  };

  const save = async () => {
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/program-data/program/${encodeURIComponent(programName)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includedTheatres: selected }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof result.error === "string" ? result.error : "Could not save the theatres");
        return;
      }
      const stored: string[] = Array.isArray(result.includedTheatres) ? result.includedTheatres : selected;
      setSaved(true);
      onSaved(stored);
    } catch {
      setError("Could not save the theatres");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-6 bg-white rounded-lg border border-gray-200 p-4">
      <h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-gray-800">
        <Globe size={18} /> Theatres included
      </h2>
      <p className="mb-3 text-xs text-gray-500">
        The theatres this program operates in. Leave all unticked to include every theatre. An excluded theatre is
        left out of the By Theatre view, of a Global &ldquo;compliant theatres&rdquo; count and of every
        per-theatre minimum.
      </p>
      {options.length === 0 ? (
        <p className="text-sm text-gray-500">No theatres are configured in Region Data yet.</p>
      ) : (
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {options.map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={selected.includes(t)}
                onChange={() => toggle(t)}
                className="rounded border-gray-300"
              />
              {t}
              {!known.includes(t) && <span className="text-xs text-amber-700">(not in Region Data)</span>}
            </label>
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-gray-600">
        {selected.length === 0 ? "Counting every theatre." : `Counting ${[...selected].sort().join(", ")} only.`}
      </p>
      {error && <div className="mt-3 p-2 bg-red-50 text-red-700 rounded text-sm">{error}</div>}
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || included === null}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          <Save size={15} /> {saving ? "Saving…" : "Save theatres"}
        </button>
        {saved && <span className="text-sm text-green-700">Saved.</span>}
      </div>
    </section>
  );
}
