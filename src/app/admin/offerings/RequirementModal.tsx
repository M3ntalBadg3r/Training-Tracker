"use client";

import { useEffect, useState } from "react";
import Modal from "@/components/ui/Modal";
import { OfferingDataRow } from "@/types";
import { trainingTypeLabel } from "@/lib/utils";
import { Plus, Save, X } from "lucide-react";

// Offerings support OLX (parents) in addition to the three Programs use.
const TRAINING_TYPES = ["Certification", "Accreditation", "InstructorLedTraining", "OLX"];

interface TrainingOption {
  trainingTitle: string;
  fullTitle: string;
}
interface AlternativeEntry {
  trainingType: string;
  trainingTitle: string;
  trainingFullTitle: string;
}

interface FormState {
  trainingType: string;
  trainingTitle: string;
  trainingFullTitle: string;
  quantityRequired: number;
}

const EMPTY_FORM: FormState = {
  trainingType: "",
  trainingTitle: "",
  trainingFullTitle: "",
  quantityRequired: 1,
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** The offering this requirement belongs to — fixed; the id is what's written. */
  offeringId: number;
  /** The specialisation this requirement supports — fixed, shown read-only. */
  specialisationId: number;
  specialisationName: string;
  /** null = add mode; a row = edit mode. */
  initial: OfferingDataRow | null;
  /** Called after a successful create/update so the parent can refetch. */
  onSaved: () => void;
}

/**
 * Add/Edit an offering requirement — the supporting training a partner must hold
 * (with alternatives + a minimum count) to deliver an offering's specialisation.
 * Simpler than the Programs modal: no level / purpose / tier / per-theatre min.
 */
export default function RequirementModal({
  open,
  onClose,
  offeringId,
  specialisationId,
  specialisationName,
  initial,
  onSaved,
}: Props) {
  const isEdit = initial !== null;

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [trainingOptions, setTrainingOptions] = useState<TrainingOption[]>([]);
  const [alternatives, setAlternatives] = useState<AlternativeEntry[]>([]);
  const [showAlts, setShowAlts] = useState(false);
  const [altTrainingOptions, setAltTrainingOptions] = useState<Record<string, TrainingOption[]>>({});
  const [saving, setSaving] = useState(false);

  const fetchTrainingsByType = async (type: string) => {
    if (!type) {
      setTrainingOptions([]);
      return;
    }
    try {
      const res = await fetch(`/api/training-data/by-type?type=${type}`);
      if (res.ok) setTrainingOptions(await res.json());
    } catch { /* ignore */ }
  };

  const fetchAltTrainingsByType = async (key: string, type: string) => {
    if (!type) return;
    try {
      const res = await fetch(`/api/training-data/by-type?type=${type}`);
      if (res.ok) {
        const options = await res.json();
        setAltTrainingOptions((prev) => ({ ...prev, [key]: options }));
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!open) return;
    setFormError("");
    setAltTrainingOptions({});
    if (initial) {
      setForm({
        trainingType: initial.trainingType ?? "",
        trainingTitle: initial.trainingTitle ?? "",
        trainingFullTitle: initial.trainingFullTitle ?? "",
        quantityRequired: initial.quantityRequired,
      });
      if (initial.trainingType) fetchTrainingsByType(initial.trainingType);
      const alts = initial.alternatives || [];
      setAlternatives(alts.map((a) => ({ ...a })));
      setShowAlts(alts.length > 0);
      alts.forEach((a, i) => {
        if (a.trainingType) fetchAltTrainingsByType(`${i}`, a.trainingType);
      });
    } else {
      setForm(EMPTY_FORM);
      setTrainingOptions([]);
      setAlternatives([]);
      setShowAlts(false);
    }
  }, [open, initial]);

  const handleSave = async () => {
    setFormError("");
    setSaving(true);
    try {
      const payload = {
        offeringId,
        specialisationId,
        trainingType: form.trainingType,
        trainingTitle: form.trainingTitle,
        quantityRequired: form.quantityRequired,
        alternatives: showAlts ? alternatives.filter((a) => a.trainingTitle) : [],
      };
      const url = isEdit ? `/api/admin/offering-data/${initial!.id}` : "/api/admin/offering-data";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) {
        setFormError(result.error || "Failed to save requirement");
        return;
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? "Edit Requirement" : "Add Requirement"}>
      <div className="space-y-4">
        {formError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{formError}</div>}
        <div>
          <label className="block text-sm font-medium mb-1">Specialisation</label>
          <div className="px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-sm text-gray-700">
            {specialisationName}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Type</label>
          <select
            value={form.trainingType}
            onChange={(e) => {
              const type = e.target.value;
              setForm((f) => ({ ...f, trainingType: type, trainingTitle: "", trainingFullTitle: "" }));
              fetchTrainingsByType(type);
            }}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
          >
            <option value="">Select type...</option>
            {TRAINING_TYPES.map((t) => <option key={t} value={t}>{trainingTypeLabel(t)}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Training</label>
          <select
            value={form.trainingFullTitle}
            onChange={(e) => {
              const fullTitle = e.target.value;
              const opt = trainingOptions.find((o) => o.fullTitle === fullTitle);
              setForm((f) => ({ ...f, trainingFullTitle: fullTitle, trainingTitle: opt?.trainingTitle ?? "" }));
            }}
            disabled={!form.trainingType}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm disabled:opacity-50"
          >
            <option value="">{form.trainingType ? "Select training..." : "Select a type first..."}</option>
            {trainingOptions.map((t) => <option key={t.trainingTitle} value={t.fullTitle}>{t.fullTitle}</option>)}
          </select>
        </div>

        {/* Accept alternative trainings */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="off-req-alts"
            checked={showAlts}
            onChange={(e) => {
              setShowAlts(e.target.checked);
              if (!e.target.checked) { setAlternatives([]); setAltTrainingOptions({}); }
            }}
            className="w-4 h-4"
          />
          <label htmlFor="off-req-alts" className="text-sm">Accept alternative trainings</label>
        </div>
        {showAlts && (
          <div className="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50">
            <p className="text-xs text-gray-500">Students with any of these alternative trainings will also count toward the requirement.</p>
            {alternatives.map((alt, idx) => (
              <div key={idx} className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium mb-1 text-gray-600">Type</label>
                  <select
                    value={alt.trainingType}
                    onChange={(e) => {
                      const type = e.target.value;
                      setAlternatives((prev) => prev.map((a, i) => i === idx ? { ...a, trainingType: type, trainingTitle: "", trainingFullTitle: "" } : a));
                      fetchAltTrainingsByType(`${idx}`, type);
                    }}
                    className="w-full px-2 py-1.5 border border-gray-300 rounded bg-white text-sm"
                  >
                    <option value="">Select type...</option>
                    {TRAINING_TYPES.map((t) => <option key={t} value={t}>{trainingTypeLabel(t)}</option>)}
                  </select>
                </div>
                <div className="flex-[2]">
                  <label className="block text-xs font-medium mb-1 text-gray-600">Training</label>
                  <select
                    value={alt.trainingFullTitle}
                    onChange={(e) => {
                      const fullTitle = e.target.value;
                      const opt = (altTrainingOptions[`${idx}`] || []).find((o) => o.fullTitle === fullTitle);
                      setAlternatives((prev) => prev.map((a, i) => i === idx ? { ...a, trainingTitle: opt?.trainingTitle ?? "", trainingFullTitle: fullTitle } : a));
                    }}
                    disabled={!alt.trainingType}
                    className="w-full px-2 py-1.5 border border-gray-300 rounded bg-white text-sm disabled:opacity-50"
                  >
                    <option value="">{alt.trainingType ? "Select training..." : "Select type first..."}</option>
                    {(altTrainingOptions[`${idx}`] || []).map((t) => <option key={t.trainingTitle} value={t.fullTitle}>{t.fullTitle}</option>)}
                  </select>
                </div>
                <button
                  onClick={() => setAlternatives((prev) => prev.filter((_, i) => i !== idx))}
                  className="px-2 py-1.5 text-red-600 hover:bg-red-50 rounded"
                  title="Remove alternative"
                >
                  <X size={16} />
                </button>
              </div>
            ))}
            <button
              onClick={() => setAlternatives((prev) => [...prev, { trainingType: "", trainingTitle: "", trainingFullTitle: "" }])}
              className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
            >
              <Plus size={14} /> Add Alternative
            </button>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1">Quantity Required</label>
          <input
            type="number"
            min={1}
            value={form.quantityRequired}
            onChange={(e) => setForm((f) => ({ ...f, quantityRequired: parseInt(e.target.value) || 1 }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">Minimum number of people who must hold this training (Onshore).</p>
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
