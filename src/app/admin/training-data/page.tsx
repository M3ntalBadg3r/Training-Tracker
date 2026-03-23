"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { TrainingDataRow } from "@/types";
import { Plus, Trash2 } from "lucide-react";

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

export default function TrainingDataPage() {
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRawTrainingData();
  }, []);

  const fetchRawTrainingData = async () => {
    const res = await fetch("/api/training-data/all");
    if (res.ok) {
      const data = await res.json();
      setTrainingList(data);
    }
    setLoading(false);
  };

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading training data...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Training Data" showBack />

      <section className="mb-8">
        <div className="flex items-center justify-end mb-4">
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
    </div>
  );
}
