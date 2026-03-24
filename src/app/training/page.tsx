"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import DataTable from "@/components/data-table/DataTable";
import { ColumnDef, TrainingAvailableRow } from "@/types";
import { trainingTypeLabel, functionTypeLabel } from "@/lib/utils";

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

  useEffect(() => {
    fetch("/api/training-data")
      .then((res) => res.json())
      .then((data) => {
        setTraining(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
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
      <DataTable<TrainingAvailableRow>
        data={training}
        columns={columns}
        rowAction={{
          label: "View Students",
          onClick: (row) =>
            router.push(
              `/training/${encodeURIComponent(row.fullTitle)}?trainingType=${encodeURIComponent(row.trainingType)}`
            ),
        }}
      />
    </div>
  );
}
