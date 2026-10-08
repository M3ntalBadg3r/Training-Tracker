/**
 * Server-side search / filter / sort / paging for the student list
 * (`GET /api/students`). Everything runs in SQL through Prisma — `contains` /
 * `equals` with `mode: "insensitive"`, `orderBy`, `skip`/`take` and `count` —
 * so a request never loads the whole student table into memory.
 *
 * Company scope follows the fail-closed convention: `null` = unrestricted,
 * any array (including `[]`) is applied as `companyId IN (…)`, so an empty
 * scope matches nothing even if a caller forgets its early return.
 *
 * Server only — imports Prisma. The shared vocabulary lives in
 * `students-list-params.ts`, which the client page imports.
 */
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { displayRegion } from "@/lib/group-by";
import {
  MAX_COMPANY_FILTER_OPTIONS,
  type StudentFilterOptions,
  type StudentListQuery,
  type StudentListResponse,
  type StudentSortKey,
} from "@/lib/students-list-params";

const insensitive = (value: string) => ({ contains: value, mode: "insensitive" as const });
const equalsInsensitive = (value: string) => ({ equals: value, mode: "insensitive" as const });

function scopeWhere(companyFilter: number[] | null): Prisma.StudentWhereInput {
  return companyFilter ? { companyId: { in: companyFilter } } : {};
}

/**
 * @param includeCompanyInSearch whether "All columns" search also matches the
 *   company name. The page shows the Company column only under "All companies"
 *   (i.e. when the request carries no `?companyId=`); matching a hidden column
 *   would return rows whose visible cells do not contain the term.
 */
export function buildStudentWhere(
  query: StudentListQuery,
  companyFilter: number[] | null,
  includeCompanyInSearch: boolean
): Prisma.StudentWhereInput {
  const and: Prisma.StudentWhereInput[] = [scopeWhere(companyFilter)];

  if (query.q) {
    const byColumn: Record<StudentSortKey, Prisma.StudentWhereInput> = {
      fullName: { fullName: insensitive(query.q) },
      email: { email: insensitive(query.q) },
      companyName: { company: { name: insensitive(query.q) } },
      theatre: { theatre: insensitive(query.q) },
      region: { regionData: { is: { region: insensitive(query.q) } } },
      country: { country: insensitive(query.q) },
    };
    if (query.qCol === "all") {
      and.push({
        OR: [
          byColumn.fullName,
          byColumn.email,
          ...(includeCompanyInSearch ? [byColumn.companyName] : []),
          byColumn.theatre,
          byColumn.region,
          byColumn.country,
        ],
      });
    } else {
      and.push(byColumn[query.qCol]);
    }
  }

  const f = query.filters;
  if (f.theatre) and.push({ theatre: equalsInsensitive(f.theatre) });
  if (f.country) and.push({ country: equalsInsensitive(f.country) });
  if (f.region) and.push({ regionData: { is: { region: equalsInsensitive(f.region) } } });
  if (f.companyName) and.push({ company: { name: equalsInsensitive(f.companyName) } });

  return { AND: and };
}

function orderByFor(
  sort: StudentSortKey,
  dir: "asc" | "desc"
): Prisma.StudentOrderByWithRelationInput[] {
  const primary: Record<StudentSortKey, Prisma.StudentOrderByWithRelationInput> = {
    fullName: { fullName: dir },
    email: { email: dir },
    companyName: { company: { name: dir } },
    theatre: { theatre: dir },
    region: { regionData: { region: dir } },
    country: { country: dir },
  };
  // Email is the primary key, so it makes the order total — without a unique
  // tiebreak, rows with equal sort values could move between pages.
  return sort === "email" ? [primary.email] : [primary[sort], { email: dir }];
}

const ROW_SELECT = {
  email: true,
  fullName: true,
  theatre: true,
  country: true,
  companyId: true,
  regionData: { select: { region: true } },
  company: { select: { name: true } },
} satisfies Prisma.StudentSelect;

export async function listStudents(
  query: StudentListQuery,
  companyFilter: number[] | null,
  opts: { includeCompanyInSearch: boolean }
): Promise<StudentListResponse> {
  const where = buildStudentWhere(query, companyFilter, opts.includeCompanyInSearch);
  const orderBy = orderByFor(query.sort, query.sortDir);
  const fetchPage = (page: number) =>
    prisma.student.findMany({
      where,
      orderBy,
      select: ROW_SELECT,
      skip: (page - 1) * query.pageSize,
      take: query.pageSize,
    });

  let page = query.page;
  const [total, firstPage] = await Promise.all([prisma.student.count({ where }), fetchPage(page)]);
  let students = firstPage;

  // A page past the end (a stale link, or rows deleted since) is clamped to the
  // last page rather than answered with an empty table.
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
  if (page > lastPage) {
    page = lastPage;
    students = total > 0 ? await fetchPage(page) : [];
  }

  return {
    rows: students.map((s) => ({
      email: s.email,
      fullName: s.fullName,
      theatre: s.theatre,
      country: s.country,
      region: s.regionData?.region || null,
      companyId: s.companyId,
      companyName: s.company?.name ?? null,
    })),
    total,
    page,
    pageSize: query.pageSize,
  };
}

const byLocale = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * The values offered by the column filter dropdowns: the distinct theatres,
 * regions, countries and companies **present among the students in scope**
 * (what the client-side table offered). Uses SQL `GROUP BY` rather than
 * loading students — the geography groups are bounded by the country list, a
 * few hundred at most. Companies are capped: above MAX_COMPANY_FILTER_OPTIONS
 * the list is `null` and the page offers no Company dropdown.
 */
export async function studentFilterOptions(
  companyFilter: number[] | null
): Promise<StudentFilterOptions> {
  const where = scopeWhere(companyFilter);
  const [geoGroups, companyGroups] = await Promise.all([
    prisma.student.groupBy({ by: ["country", "theatre"], where }),
    prisma.student.groupBy({
      by: ["companyId"],
      where,
      orderBy: { companyId: "asc" },
      take: MAX_COMPANY_FILTER_OPTIONS + 1,
    }),
  ]);

  const countries = Array.from(new Set(geoGroups.map((g) => g.country).filter(Boolean)));
  const theatres = Array.from(new Set(geoGroups.map((g) => g.theatre).filter(Boolean)));

  const [regionRows, companyRows] = await Promise.all([
    countries.length > 0
      ? prisma.regionData.findMany({
          where: { country: { in: countries } },
          select: { region: true },
        })
      : Promise.resolve([]),
    companyGroups.length > 0 && companyGroups.length <= MAX_COMPANY_FILTER_OPTIONS
      ? prisma.company.findMany({
          where: { id: { in: companyGroups.map((g) => g.companyId) } },
          select: { name: true },
        })
      : Promise.resolve([]),
  ]);

  // A country with no region defined renders a blank Region cell, so (as
  // before) it contributes no option to the Region dropdown.
  const regions = Array.from(
    new Set(regionRows.map((r) => displayRegion(r.region)).filter(Boolean))
  );

  return {
    theatres: theatres.sort(byLocale),
    regions: regions.sort(byLocale),
    countries: countries.sort(byLocale),
    companies:
      companyGroups.length > MAX_COMPANY_FILTER_OPTIONS
        ? null
        : companyRows.map((c) => c.name).sort(byLocale),
  };
}
