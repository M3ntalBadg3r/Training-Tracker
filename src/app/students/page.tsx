"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import DataTable from "@/components/data-table/DataTable";
import { ColumnDef, StudentRow } from "@/types";

const columns: ColumnDef<StudentRow>[] = [
  { key: "fullName", header: "Full Name" },
  { key: "email", header: "Email Address" },
  { key: "theatre", header: "Theatre" },
  { key: "region", header: "Region", accessor: (row) => row.region || "N/A" },
  { key: "country", header: "Country" },
];

export default function StudentsPage() {
  const router = useRouter();
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/students")
      .then((res) => res.json())
      .then((data) => {
        setStudents(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading students...</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Students" />
      <DataTable<StudentRow>
        data={students}
        columns={columns}
        rowAction={{
          label: "View",
          onClick: (row) =>
            router.push(`/students/${encodeURIComponent(row.email)}`),
        }}
      />
    </div>
  );
}
