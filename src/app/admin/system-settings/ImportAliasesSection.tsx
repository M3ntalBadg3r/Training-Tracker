"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import {
  IMPORT_TARGET_FIELDS,
  type ImportTargetFieldKey,
} from "@/lib/import-target-fields";

interface AliasRow {
  id: number;
  targetField: ImportTargetFieldKey;
  alias: string;
}

export default function ImportAliasesSection() {
  const [rows, setRows] = useState<AliasRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/admin/import-aliases");
      if (!res.ok) {
        setError("Failed to load aliases");
        return;
      }
      setRows(await res.json());
      setError(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading aliases...</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Import Aliases</h2>
      <p className="text-sm text-gray-500 mb-6">
        Header variants the student-import wizard recognises automatically. Each
        target field can have multiple aliases &mdash; e.g.{" "}
        <code className="text-xs">Email Address</code> and{" "}
        <code className="text-xs">Student Email</code> both map to{" "}
        <strong>Email Address</strong>. Matching is case-insensitive and ignores
        spaces and punctuation.
      </p>

      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {IMPORT_TARGET_FIELDS.map((field) => (
          <FieldAliasGroup
            key={field.key}
            field={field}
            rows={rows.filter((r) => r.targetField === field.key)}
            onChange={load}
            onError={setError}
          />
        ))}
      </div>
    </div>
  );
}

function FieldAliasGroup({
  field,
  rows,
  onChange,
  onError,
}: {
  field: { key: ImportTargetFieldKey; label: string };
  rows: AliasRow[];
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [newAlias, setNewAlias] = useState("");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    const trimmed = newAlias.trim();
    if (!trimmed) return;
    setAdding(true);
    onError(null);
    try {
      const res = await fetch("/api/admin/import-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetField: field.key, alias: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onError(data.error || "Failed to add alias");
        return;
      }
      setNewAlias("");
      onChange();
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <div className="text-sm font-medium text-gray-900 mb-2">{field.label}</div>
      <div className="space-y-1">
        {rows.length === 0 && (
          <div className="text-xs text-gray-400 italic">No aliases yet.</div>
        )}
        {rows.map((row) => (
          <AliasRowItem key={row.id} row={row} onChange={onChange} onError={onError} />
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={newAlias}
          onChange={(e) => setNewAlias(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="Add an alias..."
          className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={add}
          disabled={adding || !newAlias.trim()}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={14} /> Add
        </button>
      </div>
    </div>
  );
}

function AliasRowItem({
  row,
  onChange,
  onError,
}: {
  row: AliasRow;
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.alias);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === row.alias) {
      setEditing(false);
      setValue(row.alias);
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(`/api/admin/import-aliases/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onError(data.error || "Failed to rename alias");
        return;
      }
      setEditing(false);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete alias "${row.alias}"?`)) return;
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(`/api/admin/import-aliases/${row.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onError(data.error || "Failed to delete alias");
        return;
      }
      onChange();
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 py-1">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setEditing(false);
              setValue(row.alias);
            }
          }}
          autoFocus
          className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={save}
          disabled={busy}
          className="p-1 text-green-700 hover:bg-green-50 rounded disabled:opacity-50"
          aria-label="Save"
        >
          <Check size={16} />
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setValue(row.alias);
          }}
          disabled={busy}
          className="p-1 text-gray-500 hover:bg-gray-100 rounded disabled:opacity-50"
          aria-label="Cancel"
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 py-1 px-2 rounded hover:bg-gray-50">
      <code className="text-sm text-gray-700">{row.alias}</code>
      <div className="flex items-center gap-1">
        <button
          onClick={() => setEditing(true)}
          disabled={busy}
          className="p-1 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50"
          aria-label="Rename"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={remove}
          disabled={busy}
          className="p-1 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
          aria-label="Delete"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
