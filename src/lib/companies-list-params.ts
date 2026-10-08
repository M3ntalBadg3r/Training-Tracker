/**
 * The Companies admin list's view parameters: the vocabulary, the parser and
 * the query-string builder, shared by `GET /api/admin/companies` and
 * `/admin/companies`.
 *
 * **Zero imports, deliberately** (like `students-list-params.ts`): the page is
 * a client component and `companies-list.ts` pulls in Prisma, so the one thing
 * both sides must agree on lives here. The page builds its URL mirror AND its
 * API request with `buildCompanyListParams`, and the route parses that request
 * with `parseCompanyListQuery`, so the address bar and the fetched rows cannot
 * describe different views.
 *
 * Every value read back is re-validated — a query string is user-editable
 * text. Allow-lists are tested with `includes`, never `in`, so a key such as
 * `constructor` cannot satisfy them through the prototype chain.
 */

export const COMPANY_SORT_KEYS = ["name", "studentCount"] as const;
export type CompanySortKey = (typeof COMPANY_SORT_KEYS)[number];

export const COMPANY_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_COMPANY_PAGE_SIZE = 50;
export const DEFAULT_COMPANY_SORT: CompanySortKey = "name";
export const DEFAULT_COMPANY_SORT_DIR: "asc" | "desc" = "asc";

/** Longest accepted search term; anything longer is truncated. Matches the name column's 200-char write cap. */
export const MAX_COMPANY_SEARCH_LENGTH = 200;

export interface CompanyListQuery {
  q: string;
  sort: CompanySortKey;
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
}

export interface CompanyListRow {
  id: number;
  name: string;
  studentCount: number;
  /** ISO 8601. */
  createdAt: string;
}

export interface CompanyListResponse {
  rows: CompanyListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export const DEFAULT_COMPANY_LIST_QUERY: CompanyListQuery = {
  q: "",
  sort: DEFAULT_COMPANY_SORT,
  sortDir: DEFAULT_COMPANY_SORT_DIR,
  page: 1,
  pageSize: DEFAULT_COMPANY_PAGE_SIZE,
};

/** Minimal read interface so both URLSearchParams and ReadonlyURLSearchParams fit. */
interface ParamReader {
  get(name: string): string | null;
}

export function cleanCompanySearch(raw: string | null): string {
  return (raw ?? "").trim().slice(0, MAX_COMPANY_SEARCH_LENGTH);
}

export function parseCompanySortKey(raw: string | null): CompanySortKey {
  return (COMPANY_SORT_KEYS as readonly string[]).includes(raw ?? "")
    ? (raw as CompanySortKey)
    : DEFAULT_COMPANY_SORT;
}

export function parseCompanySortDir(raw: string | null): "asc" | "desc" {
  return raw === "desc" ? "desc" : raw === "asc" ? "asc" : DEFAULT_COMPANY_SORT_DIR;
}

export function parseCompanyPage(raw: string | null): number {
  if (!raw || !/^\d{1,9}$/.test(raw)) return 1;
  const n = parseInt(raw, 10);
  return n >= 1 ? n : 1;
}

export function parseCompanyPageSize(raw: string | null): number {
  const n = raw && /^\d{1,4}$/.test(raw) ? parseInt(raw, 10) : NaN;
  return (COMPANY_PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_COMPANY_PAGE_SIZE;
}

export function parseCompanyListQuery(params: ParamReader): CompanyListQuery {
  return {
    q: cleanCompanySearch(params.get("q")),
    sort: parseCompanySortKey(params.get("sort")),
    sortDir: parseCompanySortDir(params.get("sortDir")),
    page: parseCompanyPage(params.get("page")),
    pageSize: parseCompanyPageSize(params.get("size")),
  };
}

/**
 * The one query-string builder for the view: used for the URL mirror and the
 * API request alike. Defaults are omitted so a default view has a clean URL.
 */
export function buildCompanyListParams(query: CompanyListQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.sort !== DEFAULT_COMPANY_SORT || query.sortDir !== DEFAULT_COMPANY_SORT_DIR) {
    params.set("sort", query.sort);
    params.set("sortDir", query.sortDir);
  }
  if (query.page > 1) params.set("page", String(query.page));
  if (query.pageSize !== DEFAULT_COMPANY_PAGE_SIZE) params.set("size", String(query.pageSize));
  return params;
}
