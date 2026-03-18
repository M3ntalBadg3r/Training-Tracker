"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { RegionDataRow, TrainingDataRow } from "@/types";
import { Plus, Trash2, Save, AlertTriangle } from "lucide-react";

const TRAINING_TYPES = ["Certification", "Accreditation", "InstructorLedTraining"];
const PRODUCT_TYPES = ["Cortex", "SASE", "Cloud", "Strata", "Foundation"];
const FUNCTION_TYPES = ["Sales", "PreSales", "Deployments"];

const TRAINING_TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
  InstructorLedTraining: "Instructor-Led Training",
};

const FUNCTION_TYPE_LABELS: Record<string, string> = {
  Sales: "Sales",
  PreSales: "Pre-Sales",
  Deployments: "Deployments",
};

export default function AdminPage() {
  // Region data state
  const [regions, setRegions] = useState<RegionDataRow[]>([]);
  const [newRegion, setNewRegion] = useState({ country: "", region: "" });
  const [editingRegion, setEditingRegion] = useState<string | null>(null);
  const [editRegionValue, setEditRegionValue] = useState("");

  // Training data state
  const [trainingList, setTrainingList] = useState<TrainingDataRow[]>([]);
  const [showAddTraining, setShowAddTraining] = useState(false);
  const [newTraining, setNewTraining] = useState({
    trainingTitle: "",
    fullTitle: "",
    trainingType: "Certification",
    productType: "Cortex",
    function: "Sales",
    link: "",
  });

  // Wipe state
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [wipeText, setWipeText] = useState("");
  const [wiping, setWiping] = useState(false);

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/region-data").then((r) => r.json()),
      fetch("/api/training-data").then((r) => r.json()),
    ]).then(([regionData, trainingData]) => {
      setRegions(regionData);
      // For admin we need the raw training data, not the grouped version
      fetchRawTrainingData();
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const fetchRawTrainingData = async () => {
    // Fetch all training data records (not grouped by fullTitle)
    const res = await fetch("/api/training-data/all");
    if (res.ok) {
      const data = await res.json();
      setTrainingList(data);
    }
  };

  // Region handlers
  const handleAddRegion = async () => {
    if (!newRegion.country || !newRegion.region) return;
    const res = await fetch("/api/region-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newRegion),
    });
    if (res.ok) {
      const data = await res.json();
      setRegions((prev) => [...prev, data].sort((a, b) => a.country.localeCompare(b.country)));
      setNewRegion({ country: "", region: "" });
    }
  };

  const handleUpdateRegion = async (country: string) => {
    const res = await fetch(`/api/region-data/${encodeURIComponent(country)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: editRegionValue }),
    });
    if (res.ok) {
      setRegions((prev) =>
        prev.map((r) =>
          r.country === country ? { ...r, region: editRegionValue } : r
        )
      );
      setEditingRegion(null);
    }
  };

  const handleDeleteRegion = async (country: string) => {
    const res = await fetch(`/api/region-data/${encodeURIComponent(country)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setRegions((prev) => prev.filter((r) => r.country !== country));
    }
  };

  // Training handlers
  const handleAddTraining = async () => {
    if (!newTraining.trainingTitle || !newTraining.fullTitle) return;
    const res = await fetch("/api/training-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newTraining),
    });
    if (res.ok) {
      setShowAddTraining(false);
      setNewTraining({
        trainingTitle: "",
        fullTitle: "",
        trainingType: "Certification",
        productType: "Cortex",
        function: "Sales",
        link: "",
      });
      fetchRawTrainingData();
    }
  };

  const handleDeleteTraining = async (trainingTitle: string) => {
    const res = await fetch(
      `/api/training-data/${encodeURIComponent(trainingTitle)}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      setTrainingList((prev) =>
        prev.filter((t) => t.trainingTitle !== trainingTitle)
      );
    }
  };

  // Wipe handler
  const handleWipe = async () => {
    if (wipeText !== "WIPE") return;
    setWiping(true);
    try {
      await fetch("/api/admin/wipe", { method: "POST" });
      setRegions([]);
      setTrainingList([]);
      setShowWipeConfirm(false);
      setWipeText("");
    } finally {
      setWiping(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading admin data...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Admin" />

      {/* Region Data Section */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">Region Data</h2>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b">
                <th className="px-4 py-3 text-left font-semibold">Country</th>
                <th className="px-4 py-3 text-left font-semibold">Region</th>
                <th className="px-4 py-3 text-left font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {regions.map((r) => (
                <tr key={r.country} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-3">{r.country}</td>
                  <td className="px-4 py-3">
                    {editingRegion === r.country ? (
                      <input
                        type="text"
                        value={editRegionValue}
                        onChange={(e) => setEditRegionValue(e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                      />
                    ) : (
                      r.region
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      {editingRegion === r.country ? (
                        <>
                          <button
                            onClick={() => handleUpdateRegion(r.country)}
                            className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200"
                          >
                            <Save size={14} />
                          </button>
                          <button
                            onClick={() => setEditingRegion(null)}
                            className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              setEditingRegion(r.country);
                              setEditRegionValue(r.region);
                            }}
                            className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteRegion(r.country)}
                            className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {/* Add new row */}
              <tr className="bg-gray-50">
                <td className="px-4 py-3">
                  <input
                    type="text"
                    placeholder="Country"
                    value={newRegion.country}
                    onChange={(e) =>
                      setNewRegion((prev) => ({ ...prev, country: e.target.value }))
                    }
                    className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                  />
                </td>
                <td className="px-4 py-3">
                  <input
                    type="text"
                    placeholder="Region"
                    value={newRegion.region}
                    onChange={(e) =>
                      setNewRegion((prev) => ({ ...prev, region: e.target.value }))
                    }
                    className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                  />
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={handleAddRegion}
                    className="flex items-center gap-1 px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                  >
                    <Plus size={14} /> Add
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Training Data Section */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Training Data</h2>
          <button
            onClick={() => setShowAddTraining(true)}
            className="flex items-center gap-1 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={16} /> Add Training
          </button>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold">Training Title</th>
                  <th className="px-4 py-3 text-left font-semibold">Full Title</th>
                  <th className="px-4 py-3 text-left font-semibold">Type</th>
                  <th className="px-4 py-3 text-left font-semibold">Product</th>
                  <th className="px-4 py-3 text-left font-semibold">Function</th>
                  <th className="px-4 py-3 text-left font-semibold">Link</th>
                  <th className="px-4 py-3 text-left font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {trainingList.map((t) => (
                  <tr key={t.trainingTitle} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3">{t.trainingTitle}</td>
                    <td className="px-4 py-3">{t.fullTitle}</td>
                    <td className="px-4 py-3">
                      {TRAINING_TYPE_LABELS[t.trainingType] || t.trainingType}
                    </td>
                    <td className="px-4 py-3">{t.productType}</td>
                    <td className="px-4 py-3">
                      {FUNCTION_TYPE_LABELS[t.function] || t.function}
                    </td>
                    <td className="px-4 py-3">
                      {t.link ? (
                        <a
                          href={t.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          Link
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleDeleteTraining(t.trainingTitle)}
                        className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
                {trainingList.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      No training data found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Wipe Data Section */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">Danger Zone</h2>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle size={24} className="text-red-500 shrink-0" />
            <div>
              <h3 className="font-semibold text-red-800">Wipe All Data</h3>
              <p className="text-sm text-red-600 mt-1">
                This will permanently delete all students, training records,
                training data, and region data. This action cannot be undone.
              </p>
              <button
                onClick={() => setShowWipeConfirm(true)}
                className="mt-3 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Wipe All Data
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Add Training Modal */}
      <Modal
        open={showAddTraining}
        onClose={() => setShowAddTraining(false)}
        title="Add Training"
        actions={
          <>
            <button
              onClick={() => setShowAddTraining(false)}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleAddTraining}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Add
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Training Title *</label>
            <input
              type="text"
              value={newTraining.trainingTitle}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, trainingTitle: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Full Title *</label>
            <input
              type="text"
              value={newTraining.fullTitle}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, fullTitle: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Training Type *</label>
            <select
              value={newTraining.trainingType}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, trainingType: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {TRAINING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TRAINING_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Product Type *</label>
            <select
              value={newTraining.productType}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, productType: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {PRODUCT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Function *</label>
            <select
              value={newTraining.function}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, function: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {FUNCTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FUNCTION_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Link</label>
            <input
              type="url"
              value={newTraining.link}
              onChange={(e) =>
                setNewTraining((prev) => ({ ...prev, link: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="https://..."
            />
          </div>
        </div>
      </Modal>

      {/* Wipe Confirmation Modal */}
      <Modal
        open={showWipeConfirm}
        onClose={() => {
          setShowWipeConfirm(false);
          setWipeText("");
        }}
        title="Confirm Data Wipe"
        actions={
          <>
            <button
              onClick={() => {
                setShowWipeConfirm(false);
                setWipeText("");
              }}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleWipe}
              disabled={wipeText !== "WIPE" || wiping}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {wiping ? "Wiping..." : "Confirm Wipe"}
            </button>
          </>
        }
      >
        <p className="text-gray-600 mb-3">
          This will permanently delete ALL data. Type{" "}
          <strong>WIPE</strong> to confirm.
        </p>
        <input
          type="text"
          value={wipeText}
          onChange={(e) => setWipeText(e.target.value)}
          placeholder="Type WIPE to confirm"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </Modal>
    </div>
  );
}
