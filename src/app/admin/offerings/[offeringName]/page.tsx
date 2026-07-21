"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import RequirementModal from "../RequirementModal";
import { OfferingDataRow, SpecialisationRow } from "@/types";
import { trainingTypeLabel } from "@/lib/utils";
import { Plus, Trash2, Pencil, Save, ExternalLink } from "lucide-react";

interface OfferingDetail {
  id: number;
  companyId: number;
  name: string;
  description: string | null;
  link: string | null;
  specialisations: { id: number; name: string }[];
}

function OfferingDetailInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const offeringName = decodeURIComponent(String(params.offeringName));
  const companyId = searchParams.get("companyId") ?? "";
  const companyQS = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";

  const [offering, setOffering] = useState<OfferingDetail | null>(null);
  const [rows, setRows] = useState<OfferingDataRow[]>([]);
  const [allSpecs, setAllSpecs] = useState<SpecialisationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Edit details
  const [showEdit, setShowEdit] = useState(false);
  const [editDesc, setEditDesc] = useState("");
  const [editLink, setEditLink] = useState("");
  const [editError, setEditError] = useState("");

  // Add specialisation
  const [showAddSpec, setShowAddSpec] = useState(false);
  const [addSpecId, setAddSpecId] = useState(0);
  const [addSpecError, setAddSpecError] = useState("");

  // Requirement modal
  const [reqModal, setReqModal] = useState<{ specId: number; specName: string; initial: OfferingDataRow | null } | null>(null);
  const [deleteReq, setDeleteReq] = useState<OfferingDataRow | null>(null);
  const [removeSpec, setRemoveSpec] = useState<{ id: number; name: string } | null>(null);
  const [removeSpecError, setRemoveSpecError] = useState("");

  const fetchOffering = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/offerings/${encodeURIComponent(offeringName)}${companyQS}`);
      if (res.ok) setOffering(await res.json());
      else setError("Failed to load offering");
    } catch {
      setError("Failed to load offering");
    } finally {
      setLoading(false);
    }
  }, [offeringName, companyQS]);

  const fetchRows = useCallback(async (offeringId: number) => {
    try {
      const res = await fetch(`/api/admin/offering-data${companyQS}`);
      if (res.ok) {
        const all: OfferingDataRow[] = await res.json();
        setRows(all.filter((r) => r.offeringId === offeringId));
      }
    } catch { /* ignore */ }
  }, [companyQS]);

  const fetchSpecs = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/specialisations");
      if (res.ok) setAllSpecs(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchOffering();
    fetchSpecs();
  }, [fetchOffering, fetchSpecs]);

  // Load requirement rows once the offering (and thus its id) is known.
  useEffect(() => {
    if (offering?.id != null) fetchRows(offering.id);
  }, [offering?.id, fetchRows]);

  const saveDetails = async () => {
    setEditError("");
    const res = await fetch(`/api/admin/offerings/${encodeURIComponent(offeringName)}${companyQS}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: editDesc, link: editLink }),
    });
    if (!res.ok) {
      const r = await res.json().catch(() => ({}));
      setEditError(r.error || "Failed to save");
      return;
    }
    setShowEdit(false);
    fetchOffering();
  };

  const addSpecialisation = async () => {
    setAddSpecError("");
    if (!offering || !addSpecId) { setAddSpecError("Select a specialisation"); return; }
    const ids = [...offering.specialisations.map((s) => s.id), addSpecId];
    const res = await fetch(`/api/admin/offerings/${encodeURIComponent(offeringName)}${companyQS}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specialisationIds: ids }),
    });
    if (!res.ok) {
      const r = await res.json().catch(() => ({}));
      setAddSpecError(r.error || "Failed to add");
      return;
    }
    setShowAddSpec(false);
    setAddSpecId(0);
    fetchOffering();
  };

  const doRemoveSpec = async () => {
    setRemoveSpecError("");
    if (!offering || !removeSpec) return;
    const ids = offering.specialisations.map((s) => s.id).filter((id) => id !== removeSpec.id);
    const res = await fetch(`/api/admin/offerings/${encodeURIComponent(offeringName)}${companyQS}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specialisationIds: ids }),
    });
    if (!res.ok) {
      const r = await res.json().catch(() => ({}));
      setRemoveSpecError(r.error || "Failed to remove");
      return;
    }
    setRemoveSpec(null);
    fetchOffering();
    fetchRows(offering.id);
  };

  const doDeleteReq = async () => {
    if (!deleteReq || !offering) return;
    await fetch(`/api/admin/offering-data/${deleteReq.id}`, { method: "DELETE" });
    setDeleteReq(null);
    fetchRows(offering.id);
  };

  const availableSpecs = allSpecs.filter((s) => !(offering?.specialisations ?? []).some((os) => os.id === s.id));

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>;
  if (error || !offering) return <div className="p-6 text-red-600">{error || "Offering not found"}</div>;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title={offering.name}
        showBack
        rightContent={
          <button onClick={() => { setShowEdit(true); setEditDesc(offering.description ?? ""); setEditLink(offering.link ?? ""); setEditError(""); }} className="flex items-center gap-1 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
            <Pencil size={16} /> Edit details
          </button>
        }
      />

      <div className="mb-6 border border-gray-200 rounded-xl p-4 bg-white">
        {offering.description ? <p className="text-sm text-gray-700">{offering.description}</p> : <p className="text-sm text-gray-400 italic">No description</p>}
        {offering.link && (
          <a href={offering.link} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800">
            <ExternalLink size={14} /> {offering.link}
          </a>
        )}
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900">Specialisations</h2>
        <button onClick={() => { setShowAddSpec(true); setAddSpecId(0); setAddSpecError(""); }} className="flex items-center gap-1 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
          <Plus size={16} /> Add specialisation
        </button>
      </div>

      {offering.specialisations.length === 0 ? (
        <div className="text-center py-12 text-gray-500 border border-dashed border-gray-200 rounded-xl">
          No specialisations yet. Add one to define its supporting trainings.
        </div>
      ) : (
        <div className="space-y-4">
          {offering.specialisations.map((spec) => {
            const specReqs = rows.filter((r) => r.specialisationId === spec.id);
            return (
              <div key={spec.id} className="border border-gray-200 rounded-xl bg-white overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <h3 className="font-semibold text-gray-900">{spec.name}</h3>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setReqModal({ specId: spec.id, specName: spec.name, initial: null })} className="flex items-center gap-1 px-2.5 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                      <Plus size={14} /> Add training
                    </button>
                    <button onClick={() => { setRemoveSpec({ id: spec.id, name: spec.name }); setRemoveSpecError(""); }} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Remove specialisation">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                {specReqs.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-gray-400 italic">No supporting trainings defined.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                        <th className="px-4 py-2 font-medium">Type</th>
                        <th className="px-4 py-2 font-medium">Training</th>
                        <th className="px-4 py-2 font-medium">Min required</th>
                        <th className="px-4 py-2 font-medium">Alternatives</th>
                        <th className="px-4 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {specReqs.map((r) => (
                        <tr key={r.id} className="border-b border-gray-50 last:border-0">
                          <td className="px-4 py-2 text-gray-600">{r.trainingType ? trainingTypeLabel(r.trainingType) : "—"}</td>
                          <td className="px-4 py-2 text-gray-900">{r.trainingFullTitle}</td>
                          <td className="px-4 py-2 text-gray-600">{r.quantityRequired}</td>
                          <td className="px-4 py-2 text-gray-500">{r.alternatives.length > 0 ? r.alternatives.map((a) => a.trainingFullTitle).join(", ") : "—"}</td>
                          <td className="px-4 py-2 text-right whitespace-nowrap">
                            <button onClick={() => setReqModal({ specId: spec.id, specName: spec.name, initial: r })} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded" title="Edit"><Pencil size={14} /></button>
                            <button onClick={() => setDeleteReq(r)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete"><Trash2 size={14} /></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit details */}
      <Modal open={showEdit} onClose={() => setShowEdit(false)} title="Edit Offering Details">
        <div className="space-y-4">
          {editError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{editError}</div>}
          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Link</label>
            <input value={editLink} onChange={(e) => setEditLink(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm" placeholder="https://…" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setShowEdit(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={saveDetails} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"><Save size={16} /> Save</button>
          </div>
        </div>
      </Modal>

      {/* Add specialisation */}
      <Modal open={showAddSpec} onClose={() => setShowAddSpec(false)} title="Add Specialisation">
        <div className="space-y-4">
          {addSpecError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{addSpecError}</div>}
          <select value={addSpecId} onChange={(e) => setAddSpecId(Number(e.target.value))} className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm">
            <option value={0}>Select specialisation…</option>
            {availableSpecs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {availableSpecs.length === 0 && <p className="text-xs text-gray-500">All specialisations are already added. Create more under Admin → Specialisations.</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setShowAddSpec(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={addSpecialisation} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"><Save size={16} /> Add</button>
          </div>
        </div>
      </Modal>

      {/* Remove specialisation */}
      <Modal open={removeSpec !== null} onClose={() => setRemoveSpec(null)} title="Remove Specialisation">
        <div className="space-y-4">
          {removeSpecError && <div className="p-2 bg-red-50 text-red-700 rounded text-sm">{removeSpecError}</div>}
          <p className="text-sm text-gray-600">Remove <strong>{removeSpec?.name}</strong> from this offering?</p>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setRemoveSpec(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={doRemoveSpec} className="flex items-center gap-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"><Trash2 size={16} /> Remove</button>
          </div>
        </div>
      </Modal>

      {/* Delete requirement */}
      <Modal open={deleteReq !== null} onClose={() => setDeleteReq(null)} title="Delete Requirement">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">Delete requirement <strong>{deleteReq?.trainingFullTitle}</strong>?</p>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setDeleteReq(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={doDeleteReq} className="flex items-center gap-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"><Trash2 size={16} /> Delete</button>
          </div>
        </div>
      </Modal>

      {/* Add/Edit requirement */}
      {reqModal && (
        <RequirementModal
          open={reqModal !== null}
          onClose={() => setReqModal(null)}
          offeringId={offering.id}
          specialisationId={reqModal.specId}
          specialisationName={reqModal.specName}
          initial={reqModal.initial}
          onSaved={() => { fetchRows(offering.id); fetchOffering(); }}
        />
      )}
    </div>
  );
}

export default function OfferingDetailPage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-500">Loading…</div>}>
      <OfferingDetailInner />
    </Suspense>
  );
}
