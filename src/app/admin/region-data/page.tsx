"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import { RegionDataRow } from "@/types";
import { Plus, Trash2, Save } from "lucide-react";

export default function RegionDataPage() {
  const [regions, setRegions] = useState<RegionDataRow[]>([]);
  const [newRegion, setNewRegion] = useState({ country: "", region: "" });
  const [editingRegion, setEditingRegion] = useState<string | null>(null);
  const [editRegionValue, setEditRegionValue] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/region-data")
      .then((r) => r.json())
      .then((data) => {
        setRegions(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading region data...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Region Data" showBack />

      <section className="mb-8">
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
    </div>
  );
}
