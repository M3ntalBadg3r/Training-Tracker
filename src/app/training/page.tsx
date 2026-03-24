"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import DataTable from "@/components/data-table/DataTable";
import { ColumnDef, TrainingAvailableRow } from "@/types";
import { trainingTypeLabel, functionTypeLabel } from "@/lib/utils";

interface FilterOptions {
  theatres: string[];
  regions: string[];
  countries: string[];
}

const columns: ColumnDef<TrainingAvailableRow>[] = [
  { key: "fullTitle", header: "Full Title" },
  {
    key: "trainingType",
    header: "Training Type",
    accessor: (row) => trainingTypeLabel(row.trainingType),
  },
  { key: "productType", header: "Product Type" },
  {
    key: "function",
    header: "Function",
    accessor: (row) => functionTypeLabel(row.function),
  },
  {
    key: "link",
    header: "Link",
    render: (row) =>
      row.link ? (
        <a
          href={row.link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline"
        >
          Link
        </a>
      ) : (
        <span className="text-gray-400">-</span>
      ),
    filterable: false,
    sortable: false,
  },
  {
    key: "studentsTaken",
    header: "Students Taken",
    accessor: (row) => row.studentsTaken,
  },
];

export default function TrainingPage() {
  const router = useRouter();
  const [training, setTraining] = useState<TrainingAvailableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ theatres: [], regions: [], countries: [] });
  const [theatre, setTheatre] = useState("");
  const [region, setRegion] = useState("");
  const [country, setCountry] = useState("");

  const fetchTraining = useCallback(() => {
    const params = new URLSearchParams();
    if (theatre) params.set("theatre", theatre);
    if (region) params.set("region", region);
    if (country) params.set("country", country);
    const qs = params.toString();
    setLoading(true);
    fetch(`/api/training-data${qs ? `?${qs}` : ""}`)
      .then((res) => res.json())
      .then((data) => {
        setTraining(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [theatre, region, country]);

  useEffect(() => {
    fetchTraining();
  }, [fetchTraining]);

  useEffect(() => {
    fetch("/api/training-data/filters")
      .then((res) => res.json())
      .then((data) => setFilterOptions(data))
      .catch(() => {});
    fetch("/api/import-metadata?key=training-data")
      .then((res) => res.json())
      .then((data) => {
        if (data?.timestamp) setLastImport(data.timestamp);
      })
      .catch(() => {});
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading training data...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Training"
        helpSlug="training"
        rightContent={
          lastImport && (
            <span className="text-sm text-gray-500">
              Last imported: {new Date(lastImport).toLocaleString()}
            </span>
          )
        }
      />
      <div className="flex items-center gap-3 mb-4">
        <select
          value={theatre}
          onChange={(e) => setTheatre(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Theatres</option>
          {filterOptions.theatres.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Regions</option>
          {filterOptions.regions.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Countries</option>
          {filterOptions.countries.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        {(theatre || region || country) && (
          <button
            onClick={() => { setTheatre(""); setRegion(""); setCountry(""); }}
            className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      <DataTable<TrainingAvailableRow>
        data={training}
        columns={columns}
        rowAction={{
          label: "View Students",
          onClick: (row) => {
            const params = new URLSearchParams();
            params.set("trainingType", row.trainingType);
            if (theatre) params.set("theatre", theatre);
            if (region) params.set("region", region);
            if (country) params.set("country", country);
            router.push(`/training/${encodeURIComponent(row.fullTitle)}?${params.toString()}`);
          },
        }}
      />
    </div>
  );
}
