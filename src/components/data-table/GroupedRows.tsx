"use client";

import * as React from "react";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Group, GroupByMode, GROUP_BY_LABEL } from "@/lib/group-by";

interface Props<T> {
  groups: Group<T>[];
  groupBy: GroupByMode | null;
  renderRow: (row: T, idx: number) => React.ReactNode;
  /** Optional subtotal row content rendered below each group when not collapsed. */
  renderSubtotal?: (group: Group<T>) => React.ReactNode;
  colSpanTotal: number;
  emptyMessage: string;
}

export default function GroupedRows<T>({
  groups,
  groupBy,
  renderRow,
  renderSubtotal,
  colSpanTotal,
  emptyMessage,
}: Props<T>) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const totalRows = groups.reduce((s, g) => s + g.rows.length, 0);
  if (totalRows === 0) {
    return (
      <tbody>
        <tr>
          <td colSpan={colSpanTotal} className="px-4 py-8 text-center text-gray-500">
            {emptyMessage}
          </td>
        </tr>
      </tbody>
    );
  }

  if (!groupBy) {
    return <tbody>{groups.flatMap((g) => g.rows).map((row, idx) => renderRow(row, idx))}</tbody>;
  }

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <tbody>
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.key);
        return (
          <React.Fragment key={g.key}>
            <tr
              className="bg-gray-100 border-b cursor-pointer select-none"
              onClick={() => toggle(g.key)}
            >
              <td colSpan={colSpanTotal} className="px-4 py-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span>
                    {GROUP_BY_LABEL[groupBy]}: {g.key}
                  </span>
                  <span className="ml-auto text-xs font-normal text-gray-500">
                    {g.rows.length} record{g.rows.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </td>
            </tr>
            {!isCollapsed && g.rows.map((row, idx) => renderRow(row, idx))}
            {!isCollapsed && renderSubtotal && (
              <tr className="bg-gray-50 border-b font-medium text-xs text-gray-600">
                {renderSubtotal(g)}
              </tr>
            )}
          </React.Fragment>
        );
      })}
    </tbody>
  );
}
