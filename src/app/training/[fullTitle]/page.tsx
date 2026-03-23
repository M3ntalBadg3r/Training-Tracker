"use client";

import { useEffect, useState, use } from "react";
import PageHeader from "@/components/layout/PageHeader";
import DataTable from "@/components/data-table/DataTable";
import Badge from "@/components/ui/Badge";
import { ColumnDef, TrainingTakenRow } from "@/types";

const columns: ColumnDef<TrainingTakenRow>[] = [
  { key: "fullName", header: "Full Name" },
  { key: "email", header: "Email Address" },
  { key: "theatre", header: "Theatre" },
  { key: "country", header: "Country" },
  {
    key: "active",
    header: "Active",
    render: (row) => <Badge active={row.active} />,
    accessor: (row) => (row.active ? "Yes" : "No"),
  },
];

export default function TrainingTakenPage({
  params,
}: {
  params: Promise<{ fullTitle: string }>;
}) {
  const resolvedParams = use(params);
  const fullTitle = decodeURIComponent(resolvedParams.fullTitle);

  const [students, setStudents] = useState<TrainingTakenRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(
      `/api/training-taken?fullTitle=${encodeURIComponent(fullTitle)}`
    )
      .then((res) => res.json())
      .then((data) => {
        setStudents(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [fullTitle]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={fullTitle} showBack helpSlug="training-detail" />
      <p className="text-gray-600 mb-4">
        {students.length} student(s) have taken this training
      </p>
      <DataTable<TrainingTakenRow>
        data={students}
        columns={columns}
      />
    </div>
  );
}
