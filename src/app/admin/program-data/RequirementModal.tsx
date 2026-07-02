"use client";

import { useEffect, useState } from "react";
import Modal from "@/components/ui/Modal";
import { ProgramDataRow, SpecialisationRow } from "@/types";
import { trainingTypeLabel } from "@/lib/utils";
import { Plus, Save, X } from "lucide-react";

const TRAINING_TYPES = ["Certification", "Accreditation", "InstructorLedTraining"];
const LEVELS = ["Country", "Theatre", "Global"];
const LEVEL_LABELS: Record<string, string> = {
  Country: "Country",
  Theatre: "Theatre",
  Global: "Global",
};

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
  specialisationId: number;
  purpose: string;
  level: string;
  trainingType: string;
  trainingTitle: string;
  quantityRequired: number;
  minimumPerTheatre: number | null;
}

const EMPTY_FORM: FormState = {
  specialisationId: 0,
  purpose: "qualification",
  level: "",
  trainingType: "",
  trainingTitle: "",
  quantityRequired: 1,
  minimumPerTheatre: null,
};

/**
 * A requirement belongs to either a specialisation or a tier. Tier scope fixes
 * the tier (shown read-only) and always writes a deployment requirement.
 */
export type RequirementScope =
  | { kind: "specialisation" }
  | { kind: "tier"; tierId: number; tierName: string };

interface Props {
  open: boolean;
  onClose: () => void;
  /** The program this requirement belongs to — fixed, shown read-only. */
  programName: string;
  specialisations: SpecialisationRow[];
  /** null = add mode; a row = edit mode. */
  initial: ProgramDataRow | null;
  /** Called after a successful create/update so the parent can refetch. */
  onSaved: () => void;
  /** Called after a specialisation is added so the parent can refresh its list. */
  onSpecialisationAdded?: () => void;
  /** Whether the requirement targets a specialisation or a tier. Default: specialisation. */
  scope?: RequirementScope;
  /**
   * When true (tiered program, specialisation scope), expose the qualification
   * vs deployment purpose selector.
   */
  allowPurpose?: boolean;
}

/**
 * Add/Edit a program requirement. The program name is fixed by the `programName`
 * prop (no program selector / no "add program" affordance) — this modal is used
 * from a specific program's detail page and always writes to that program.
 */
export default function RequirementModal({
  open,
  onClose,
  programName,
  specialisations,
  initial,
  onSaved,
  onSpecialisationAdded,
  scope = { kind: "specialisation" },
  allowPurpose = false,
}: Props) {
  const isEdit = initial !== null;
  const isTierScope = scope.kind === "tier";

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [noTraining, setNoTraining] = useState(false);
  const [formError, setFormError] = useState("");
  const [trainingOptions, setTrainingOptions] = useState<TrainingOption[]>([]);
  const [alternatives, setAlternatives] = useState<AlternativeEntry[]>([]);
  const [showAlts, setShowAlts] = useState(false);
  const [altTrainingOptions, setAltTrainingOptions] = useState<Record<string, TrainingOption[]>>({});
  const [saving, setSaving] = useState(false);

  // Add-Specialisation sub-modal
  const [showAddSpec, setShowAddSpec] = useState(false);
  const [newSpecName, setNewSpecName] = useState("");
  const [addSpecError, setAddSpecError] = useState("");

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

  // Initialise form state whenever the modal opens (or the target row changes).
  useEffect(() => {
    if (!open) return;
    setFormError("");
    setAltTrainingOptions({});
    if (initial) {
      setForm({
        specialisationId: initial.specialisationId ?? 0,
        purpose: initial.purpose ?? "qualification",
        level: initial.level,
        trainingType: initial.trainingType ?? "",
        trainingTitle: initial.trainingTitle ?? "",
        quantityRequired: initial.quantityRequired,
        minimumPerTheatre: initial.minimumPerTheatre ?? null,
      });
      setNoTraining(initial.level === "Global" && initial.trainingTitle === null);
      if (initial.trainingType) fetchTrainingsByType(initial.trainingType);
      const alts = initial.alternatives || [];
      setAlternatives(alts.map((a) => ({ ...a })));
      setShowAlts(alts.length > 0);
      alts.forEach((a, i) => {
        if (a.trainingType) fetchAltTrainingsByType(`${i}`, a.trainingType);
      });
    } else {
      setForm(EMPTY_FORM);
      setNoTraining(false);
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
        programName,
        ...(isTierScope
          ? { tierId: scope.tierId, purpose: "deployment" }
          : { specialisationId: form.specialisationId, purpose: allowPurpose ? form.purpose : "qualification" }),
        level: form.level,
        trainingType: noTraining ? null : form.trainingType,
        trainingTitle: noTraining ? null : form.trainingTitle,
        quantityRequired: form.quantityRequired,
        minimumPerTheatre: noTraining ? null : (form.minimumPerTheatre ?? null),
        alternatives: showAlts ? alternatives.filter((a) => a.trainingTitle) : [],
      };
      const url = isEdit ? `/api/admin/program-data/${initial!.id}` : "/api/admin/program-data";
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

  const handleAddSpecialisation = async () => {
    setAddSpecError("");
    const res = await fetch("/api/admin/specialisations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newSpecName }),
    });
    const result = await res.json();
    if (!res.ok) {
      setAddSpecError(result.error || "Failed to add specialisation");
      return;
    }
    setShowAddSpec(false);
    setNewSpecName("");
    onSpecialisationAdded?.();
    setForm((f) => ({ ...f, specialisationId: result.id }));
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title={isEdit ? "Edit Requirement" : "Add Requirement"}>
        <div className="space-y-4">
          {formError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{formError}</div>}
          <div>
            <label className="block text-sm font-medium mb-1">Program</label>
            <div className="px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-sm text-gray-700">
              {programName}
            </div>
          </div>
          {isTierScope ? (
            <div>
              <label className="block text-sm font-medium mb-1">Tier</label>
              <div className="px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-sm text-gray-700">
                {scope.tierName} · deployment requirement
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">Specialisation</label>
                <div className="flex gap-2">
                  <select
                    value={form.specialisationId}
                    onChange={(e) => setForm((f) => ({ ...f, specialisationId: Number(e.target.value) }))}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                  >
                    <option value={0}>Select specialisation...</option>
                    {specialisations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button
                    onClick={() => { setShowAddSpec(true); setAddSpecError(""); setNewSpecName(""); }}
                    className="px-3 py-2 text-sm bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200"
                    title="Add new specialisation"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
              {allowPurpose && (
                <div>
                  <label className="block text-sm font-medium mb-1">Purpose</label>
                  <select
                    value={form.purpose}
                    onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                  >
                    <option value="qualification">Qualification (earns the specialisation)</option>
                    <option value="deployment">Deployment (for tiers, per-achieved-specialisation)</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    Qualifying requirements decide when the specialisation is achieved. Deployment
                    requirements are used by tiers running in &ldquo;per achieved specialisation&rdquo; mode.
                  </p>
                </div>
              )}
            </>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">Level</label>
            <select
              value={form.level}
              onChange={(e) => {
                const lvl = e.target.value;
                setForm((f) => ({ ...f, level: lvl }));
                setNoTraining(false);
                if (lvl !== "Global") fetchTrainingsByType(form.trainingType);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            >
              <option value="">Select level...</option>
              {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
            </select>
          </div>
          {form.level === "Global" && (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="req-no-training"
                checked={noTraining}
                onChange={(e) => {
                  setNoTraining(e.target.checked);
                  if (e.target.checked) setTrainingOptions([]);
                }}
                className="w-4 h-4"
              />
              <label htmlFor="req-no-training" className="text-sm">
                No specific training (count compliant theatres)
              </label>
            </div>
          )}
          {(form.level !== "Global" || !noTraining) && (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">Type</label>
                <select
                  value={form.trainingType}
                  onChange={(e) => {
                    const type = e.target.value;
                    setForm((f) => ({ ...f, trainingType: type, trainingTitle: "" }));
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
                  value={form.trainingTitle}
                  onChange={(e) => setForm((f) => ({ ...f, trainingTitle: e.target.value }))}
                  disabled={!form.trainingType}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm disabled:opacity-50"
                >
                  <option value="">{form.trainingType ? "Select training..." : "Select a type first..."}</option>
                  {trainingOptions.map((t) => <option key={t.trainingTitle} value={t.trainingTitle}>{t.fullTitle}</option>)}
                </select>
              </div>
              {form.level === "Global" && (
                <div>
                  <label className="block text-sm font-medium mb-1">Minimum per Theatre (optional)</label>
                  <input
                    type="number"
                    min={0}
                    value={form.minimumPerTheatre ?? ""}
                    onChange={(e) => setForm((f) => ({ ...f, minimumPerTheatre: e.target.value ? parseInt(e.target.value) : null }))}
                    placeholder="Leave blank if no per-theatre minimum"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                  />
                  <p className="mt-1 text-xs text-gray-500">Leave blank if no per-theatre minimum applies.</p>
                </div>
              )}
              {/* Accept alternative trainings */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="req-alts"
                  checked={showAlts}
                  onChange={(e) => {
                    setShowAlts(e.target.checked);
                    if (!e.target.checked) { setAlternatives([]); setAltTrainingOptions({}); }
                  }}
                  className="w-4 h-4"
                />
                <label htmlFor="req-alts" className="text-sm">
                  Accept alternative trainings
                </label>
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
                          value={alt.trainingTitle}
                          onChange={(e) => {
                            const title = e.target.value;
                            const opt = (altTrainingOptions[`${idx}`] || []).find((o) => o.trainingTitle === title);
                            setAlternatives((prev) => prev.map((a, i) => i === idx ? { ...a, trainingTitle: title, trainingFullTitle: opt?.fullTitle ?? "" } : a));
                          }}
                          disabled={!alt.trainingType}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded bg-white text-sm disabled:opacity-50"
                        >
                          <option value="">{alt.trainingType ? "Select training..." : "Select type first..."}</option>
                          {(altTrainingOptions[`${idx}`] || []).map((t) => <option key={t.trainingTitle} value={t.trainingTitle}>{t.fullTitle}</option>)}
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
            </>
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
            <p className="mt-1 text-xs text-gray-500">
              {form.level === "Global" && noTraining
                ? "Number of compliant theatres needed."
                : "Number of people with this training needed."}
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              <Save size={16} /> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </Modal>

      {/* Add Specialisation Modal */}
      <Modal open={showAddSpec} onClose={() => setShowAddSpec(false)} title="Add Specialisation">
        <div className="space-y-4">
          {addSpecError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{addSpecError}</div>}
          <div>
            <label className="block text-sm font-medium mb-1">Specialisation Name</label>
            <input
              type="text"
              value={newSpecName}
              onChange={(e) => setNewSpecName(e.target.value)}
              placeholder="e.g., a product or solution area"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setShowAddSpec(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={handleAddSpecialisation} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <Save size={16} /> Save
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
