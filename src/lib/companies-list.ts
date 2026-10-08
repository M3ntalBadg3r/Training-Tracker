/**
 * Server-side search / sort / paging for the Companies admin list
 * (`GET /api/admin/companies`). Everything runs in SQL through Prisma —
 * `contains` with `mode: "insensitive"`, `orderBy`, `skip`/`take` and `count` —
 * so a request never loads the whole company table, and the per-company
 * student count is computed for the page's rows only.
 *
 * Unscoped by design: the route is SuperAdmin-only and SuperAdmins see every
 * company. A future non-SuperAdmin caller must add a company-scope filter.
 *
 * Server only — imports Prisma. The shared vocabulary lives in
 * `companies-list-params.ts`, which the client page imports.
 */
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import type {
  CompanyListQuery,
  CompanyListResponse,
} from "@/lib/companies-list-params";

function orderByFor(query: CompanyListQuery): Prisma.CompanyOrderByWithRelationInput[] {
  const dir = query.sortDir;
  // `name` is unique, so it makes the order total on its own. Sorting by
  // student count ties constantly (most companies hold 0–2 students), so it
  // falls back to name and then id — without a unique tiebreak, rows with
  // equal counts could move between pages.
  return query.sort === "studentCount"
    ? [{ students: { _count: dir } }, { name: "asc" }, { id: "asc" }]
    : [{ name: dir }];
}

export async function listCompanies(query: CompanyListQuery): Promise<CompanyListResponse> {
  const where: Prisma.CompanyWhereInput = query.q
    ? { name: { contains: query.q, mode: "insensitive" } }
    : {};
  const orderBy = orderByFor(query);
  const fetchPage = (page: number) =>
    prisma.company.findMany({
      where,
      orderBy,
      skip: (page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        name: true,
        createdAt: true,
        _count: { select: { students: true } },
      },
    });

  let page = query.page;
  const [total, firstPage] = await Promise.all([prisma.company.count({ where }), fetchPage(page)]);
  let companies = firstPage;

  // A page past the end (a stale link, or a delete that emptied the last page)
  // is clamped to the last page rather than answered with an empty table.
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
  if (page > lastPage) {
    page = lastPage;
    companies = total > 0 ? await fetchPage(page) : [];
  }

  return {
    rows: companies.map((c) => ({
      id: c.id,
      name: c.name,
      studentCount: c._count.students,
      createdAt: c.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize: query.pageSize,
  };
}
