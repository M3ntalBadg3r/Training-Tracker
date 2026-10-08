/**
 * The student list's view parameters: the vocabulary, the parser and the
 * query-string builder, shared by `GET /api/students` and `/students`.
 *
 * **Zero imports, deliberately** (like `program-levels.ts`): the page is a
 * client component and `students-list.ts` pulls in Prisma, so the one thing
 * both sides must agree on lives here. The page builds its URL mirror AND its
 * API request with `buildStudentListParams`, and the route parses that request
 * with `parseStudentListQuery`, so the address bar and the fetched rows cannot
 * describe different views.
 *
 * The parameter names are the ones the page mirrored when it was a client-side
 * `DataTable` (`q`/`qCol`/`sort`/`sortDir`/`f_<col>`/`page`/`size`), so links
 * and back-navigation entries written before server paging still resolve.
 * `f_fullName`/`f_email` from those links are ignored: those two columns no
 * longer offer a filter dropdown (search covers them).
 *
 * Every value read back is re-validated — a query string is user-editable
 * text. Allow-lists are tested with `includes`, never `in`, so a key such as
 * `constructor` cannot satisfy them through the prototype chain.
 */

export const STUDENT_SORT_KEYS = [
  "fullName",
  "email",
  "companyName",
  "theatre",
  "region",
  "country",
] as const;
export type StudentSortKey = (typeof STUDENT_SORT_KEYS)[number];

export const STUDENT_SEARCH_COLUMNS = ["all", ...STUDENT_SORT_KEYS] as const;
export type StudentSearchColumn = (typeof STUDENT_SEARCH_COLUMNS)[number];

/** Columns that offer an exact-match filter dropdown. */
export const STUDENT_FILTER_KEYS = ["companyName", "theatre", "region", "country"] as const;
export type StudentFilterKey = (typeof STUDENT_FILTER_KEYS)[number];

export const STUDENT_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_STUDENT_PAGE_SIZE = 50;
export const DEFAULT_STUDENT_SORT: StudentSortKey = "fullName";
export const DEFAULT_STUDENT_SORT_DIR: "asc" | "desc" = "asc";

/** Longest accepted search term / filter value; anything longer is truncated. */
export const MAX_STUDENT_SEARCH_LENGTH = 200;

/**
 * Above this many companies in scope the Company filter is not offered — a
 * select with thousands of options is not a control, and the header company
 * switcher already narrows to one company.
 */
export const MAX_COMPANY_FILTER_OPTIONS = 500;

export type StudentFilters = Partial<Record<StudentFilterKey, string>>;

export interface StudentListQuery {
  q: string;
  qCol: StudentSearchColumn;
  sort: StudentSortKey;
  sortDir: "asc" | "desc";
  filters: StudentFilters;
  page: number;
  pageSize: number;
}

export interface StudentListRow {
  email: string;
  fullName: string;
  theatre: string;
  country: string;
  region: string | null;
  companyId: number;
  companyName: string | null;
}

export interface StudentListResponse {
  rows: StudentListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StudentFilterOptions {
  theatres: string[];
  regions: string[];
  countries: string[];
  /** `null` = more than MAX_COMPANY_FILTER_OPTIONS companies; no dropdown. */
  companies: string[] | null;
}

export const EMPTY_STUDENT_FILTER_OPTIONS: StudentFilterOptions = {
  theatres: [],
  regions: [],
  countries: [],
  companies: [],
};

/** Minimal read interface so both URLSearchParams and ReadonlyURLSearchParams fit. */
interface ParamReader {
  get(name: string): string | null;
}

function cleanText(raw: string | null): string {
  return (raw ?? "").trim().slice(0, MAX_STUDENT_SEARCH_LENGTH);
}

export function parseSortKey(raw: string | null): StudentSortKey {
  return (STUDENT_SORT_KEYS as readonly string[]).includes(raw ?? "")
    ? (raw as StudentSortKey)
    : DEFAULT_STUDENT_SORT;
}

export function parseSearchColumn(raw: string | null): StudentSearchColumn {
  return (STUDENT_SEARCH_COLUMNS as readonly string[]).includes(raw ?? "")
    ? (raw as StudentSearchColumn)
    : "all";
}

export function parseSortDir(raw: string | null): "asc" | "desc" {
  return raw === "desc" ? "desc" : raw === "asc" ? "asc" : DEFAULT_STUDENT_SORT_DIR;
}

export function parsePage(raw: string | null): number {
  if (!raw || !/^\d{1,9}$/.test(raw)) return 1;
  const n = parseInt(raw, 10);
  return n >= 1 ? n : 1;
}

export function parsePageSize(raw: string | null): number {
  const n = raw && /^\d{1,4}$/.test(raw) ? parseInt(raw, 10) : NaN;
  return (STUDENT_PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_STUDENT_PAGE_SIZE;
}

export function parseStudentListQuery(params: ParamReader): StudentListQuery {
  const filters: StudentFilters = {};
  for (const key of STUDENT_FILTER_KEYS) {
    const v = cleanText(params.get(`f_${key}`));
    if (v) filters[key] = v;
  }
  // The client-side table only searched the trimmed term case-insensitively, so
  // trimming here changes nothing a user could see.
  return {
    q: cleanText(params.get("q")),
    qCol: parseSearchColumn(params.get("qCol")),
    sort: parseSortKey(params.get("sort")),
    sortDir: parseSortDir(params.get("sortDir")),
    filters,
    page: parsePage(params.get("page")),
    pageSize: parsePageSize(params.get("size")),
  };
}

/**
 * The one query-string builder for the view: used for the URL mirror and the
 * API request alike. Defaults are omitted so a default view has a clean URL.
 */
export function buildStudentListParams(
  query: StudentListQuery,
  opts: { includePage?: boolean } = {}
): URLSearchParams {
  const { includePage = true } = opts;
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.qCol !== "all") params.set("qCol", query.qCol);
  if (query.sort !== DEFAULT_STUDENT_SORT || query.sortDir !== DEFAULT_STUDENT_SORT_DIR) {
    params.set("sort", query.sort);
    params.set("sortDir", query.sortDir);
  }
  for (const key of STUDENT_FILTER_KEYS) {
    const v = query.filters[key];
    if (v) params.set(`f_${key}`, v);
  }
  if (includePage && query.page > 1) params.set("page", String(query.page));
  if (query.pageSize !== DEFAULT_STUDENT_PAGE_SIZE) params.set("size", String(query.pageSize));
  return params;
}
