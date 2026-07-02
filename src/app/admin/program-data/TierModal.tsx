"use client";

import { useEffect, useState } from "react";
import Modal from "@/components/ui/Modal";
import { ProgramTierRow } from "@/types";
import { Save } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The program this tier belongs to — fixed. */
  programName: string;
  /** null = add mode; a row = edit mode. */
  initial: ProgramTierRow | null;
  onSaved: () => void;
}

/**
 * Add/Edit a program tier (name, ladder order, and how many achieved
 * specialisations are required to reach it).
 */
export default function TierModal({ open, onClose, programName, initial, onSaved }: Props) {
  const isEdit = initial !== null;
  const [name, setName] = useState("");
  const [sortOrder, setSortOrder] = useState<number | "">("");
  const [specialisationsRequired, setSpecialisationsRequired] = useState(1);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError("");
    if (initial) {
      setName(initial.name);
      setSortOrder(initial.sortOrder);
      setSpecialisationsRequired(initial.specialisationsRequired);
    } else {
      setName("");
      setSortOrder("");
      setSpecialisationsRequired(1);
    }
  }, [open, initial]);

  const handleSave = async () => {
    setError("");
    setSaving(true);
    try {
      const payload = {
        programName,
        name,
        specialisationsRequired,
        ...(sortOrder === "" ? {} : { sortOrder }),
      };
      const url = isEdit ? `/api/admin/program-tiers/${initial!.id}` : "/api/admin/program-tiers";
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) {
        setError(result.error || "Failed to save tier");
        return;
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? "Edit Tier" : "Add Tier"}>
      <div className="space-y-4">
        {error && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{error}</div>}
        <div>
          <label className="block text-sm font-medium mb-1">Program</label>
          <div className="px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-sm text-gray-700">{programName}</div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Tier Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Tier A"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Ladder Order</label>
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value === "" ? "" : parseInt(e.target.value))}
            placeholder="Auto (next slot) if left blank"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">Lower numbers are lower tiers (e.g. Tier A = 1, Tier B = 2).</p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Specialisations Required</label>
          <input
            type="number"
            min={1}
            value={specialisationsRequired}
            onChange={(e) => setSpecialisationsRequired(parseInt(e.target.value) || 1)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">How many specialisations must be achieved to reach this tier.</p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            <Save size={16} /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
