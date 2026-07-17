"use client";

import { useState, useMemo, useEffect } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import { ColumnDef } from "@/types";
import { ChevronUp, ChevronDown, Search, ChevronLeft, ChevronRight } from "lucide-react";

export interface DataTableState {
  searchTerm: string;
  searchColumn: string;
  columnFilters: Record<string, string>;
  sortColumn: string | null;
  sortDirection: "asc" | "desc";
}

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
  pageSizeOptions?: number[];
  defaultPageSize?: number;
  defaultSortColumn?: string;
  defaultSortDirection?: "asc" | "desc";
  initialSearchTerm?: string;
  initialSearchColumn?: string;
  initialColumnFilters?: Record<string, string>;
  initialSortColumn?: string;
  initialSortDirection?: "asc" | "desc";
  onStateChange?: (state: DataTableState, visibleRows: T[]) => void;
  rowAction?: {
    label: string;
    onClick: (row: T) => void;
  };
  rowDelete?: {
    label: string;
    onDelete: (row: T) => void;
  };
  rowEdit?: {
    label: string;
    onEdit: (row: T) => void;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function DataTable<T extends Record<string, any>>({
  data,
  columns,
  pageSizeOptions = [10, 25, 50, 100],
  defaultPageSize = 50,
  defaultSortColumn,
  defaultSortDirection = "asc",
  initialSearchTerm,
  initialSearchColumn,
  initialColumnFilters,
  initialSortColumn,
  initialSortDirection,
  onStateChange,
  rowAction,
  rowDelete,
  rowEdit,
}: DataTableProps<T>) {
  const [searchTerm, setSearchTerm] = useState(initialSearchTerm ?? "");
  const [searchColumn, setSearchColumn] = useState(initialSearchColumn ?? "all");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>(initialColumnFilters ?? {});
  const [sortColumn, setSortColumn] = useState<string | null>(
    initialSortColumn ?? defaultSortColumn ?? null
  );
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">(
    initialSortDirection ?? defaultSortDirection
  );
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  const debouncedSearch = useDebounce(searchTerm);

  const getCellValue = (row: T, col: ColumnDef<T>): string => {
    if (col.accessor) {
      const val = col.accessor(row);
      return val == null ? "" : String(val);
    }
    const val = row[col.key as keyof T];
    return val == null ? "" : String(val);
  };

  const filteredData = useMemo(() => {
    let result = [...data];

    // Apply search
    if (debouncedSearch) {
      const term = debouncedSearch.toLowerCase();
      result = result.filter((row) => {
        if (searchColumn === "all") {
          return columns.some((col) =>
            getCellValue(row, col).toLowerCase().includes(term)
          );
        }
        const col = columns.find((c) => c.key === searchColumn);
        if (!col) return true;
        return getCellValue(row, col).toLowerCase().includes(term);
      });
    }

    // Apply column filters
    for (const [key, value] of Object.entries(columnFilters)) {
      if (!value) continue;
      const col = columns.find((c) => c.key === key);
      if (!col) continue;
      result = result.filter(
        (row) => getCellValue(row, col).toLowerCase() === value.toLowerCase()
      );
    }

    // Apply sorting
    if (sortColumn) {
      const col = columns.find((c) => c.key === sortColumn);
      if (col) {
        result.sort((a, b) => {
          const aVal = getCellValue(a, col);
          const bVal = getCellValue(b, col);
          const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
          return sortDirection === "asc" ? cmp : -cmp;
        });
      }
    }

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, debouncedSearch, searchColumn, columnFilters, sortColumn, sortDirection]);

  useEffect(() => {
    if (!onStateChange) return;
    onStateChange(
      { searchTerm: debouncedSearch, searchColumn, columnFilters, sortColumn, sortDirection },
      filteredData
    );
  }, [filteredData, debouncedSearch, searchColumn, columnFilters, sortColumn, sortDirection, onStateChange]);

  const totalPages = Math.max(1, Math.ceil(filteredData.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedData = filteredData.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize
  );

  const handleSort = (key: string) => {
    if (sortColumn === key) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(key);
      setSortDirection("asc");
    }
  };

  const handleColumnFilter = (key: string, value: string) => {
    setColumnFilters((prev) => ({ ...prev, [key]: value }));
    setCurrentPage(1);
  };

  const getFilterOptions = (col: ColumnDef<T>): string[] => {
    if (col.filterOptions) return col.filterOptions;
    const values = new Set<string>();
    data.forEach((row) => {
      const val = getCellValue(row, col);
      if (val) values.add(val);
    });
    return Array.from(values).sort();
  };

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setCurrentPage(1);
            }}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <select
          value={searchColumn}
          onChange={(e) => setSearchColumn(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All columns</option>
          {columns.map((col) => (
            <option key={col.key} value={col.key}>
              {col.header}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {columns.map((col) => (
                  <th key={col.key} className="px-4 py-3 text-left">
                    <div className="space-y-1">
                      <button
                        onClick={() => col.sortable !== false && handleSort(col.key)}
                        className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900"
                      >
                        {col.header}
                        {col.sortable !== false && sortColumn === col.key && (
                          sortDirection === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} />
                        )}
                      </button>
                      {col.filterable !== false && (
                        <select
                          value={columnFilters[col.key] || ""}
                          onChange={(e) => handleColumnFilter(col.key, e.target.value)}
                          className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal"
                        >
                          <option value="">All</option>
                          {getFilterOptions(col).map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </th>
                ))}
                {(rowAction || rowDelete || rowEdit) && (
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {paginatedData.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length + (rowAction || rowDelete || rowEdit ? 1 : 0)}
                    className="px-4 py-8 text-center text-gray-500"
                  >
                    No records found
                  </td>
                </tr>
              ) : (
                paginatedData.map((row, idx) => (
                  <tr
                    key={idx}
                    className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                  >
                    {columns.map((col) => (
                      <td key={col.key} className="px-4 py-3 text-gray-700">
                        {col.render ? col.render(row) : getCellValue(row, col)}
                      </td>
                    ))}
                    {(rowAction || rowDelete || rowEdit) && (
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          {rowAction && (
                            <button
                              onClick={() => rowAction.onClick(row)}
                              className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                            >
                              {rowAction.label}
                            </button>
                          )}
                          {rowEdit && (
                            <button
                              onClick={() => rowEdit.onEdit(row)}
                              className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                            >
                              {rowEdit.label}
                            </button>
                          )}
                          {rowDelete && (
                            <button
                              onClick={() => rowDelete.onDelete(row)}
                              className="px-3 py-1 text-xs font-medium text-red-600 bg-red-50 rounded-md hover:bg-red-100 transition-colors"
                            >
                              {rowDelete.label}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>Show</span>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setCurrentPage(1);
            }}
            className="border border-gray-300 rounded px-2 py-1 text-sm"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <span>records</span>
          <span className="ml-4">
            Showing {filteredData.length === 0 ? 0 : (safePage - 1) * pageSize + 1} to{" "}
            {Math.min(safePage * pageSize, filteredData.length)} of{" "}
            {filteredData.length} records
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
            className="p-2 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} />
          </button>
          {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
            let page: number;
            if (totalPages <= 5) {
              page = i + 1;
            } else if (safePage <= 3) {
              page = i + 1;
            } else if (safePage >= totalPages - 2) {
              page = totalPages - 4 + i;
            } else {
              page = safePage - 2 + i;
            }
            return (
              <button
                key={page}
                onClick={() => setCurrentPage(page)}
                className={`px-3 py-1 rounded text-sm ${
                  safePage === page
                    ? "bg-blue-600 text-white"
                    : "hover:bg-gray-100 text-gray-700"
                }`}
              >
                {page}
              </button>
            );
          })}
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage >= totalPages}
            className="p-2 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
