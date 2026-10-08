import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { listCompanies } from "@/lib/companies-list";
import { parseCompanyListQuery } from "@/lib/companies-list-params";

/**
 * GET: one page of the company list (SuperAdmin only).
 *
 * Search (`q`, name contains, case-insensitive), sort (`name` |
 * `studentCount`, with `sortDir`) and paging (`page`, `size` from a fixed set,
 * a page past the end clamped to the last) all run in SQL
 * (`lib/companies-list.ts`); every parameter is parsed and re-validated by
 * `lib/companies-list-params.ts`, the module the page uses to build the same
 * query string. Responds `{ rows: [{id, name, studentCount, createdAt}],
 * total, page, pageSize }`.
 *
 * This is the admin table's endpoint only. Pickers that need every company
 * (the header switcher, the Users / API Keys forms) read the shared
 * per-session list from `/api/companies` via `CompanyScopeProvider` instead.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const query = parseCompanyListQuery(request.nextUrl.searchParams);
    return NextResponse.json(await listCompanies(query));
  } catch (error) {
    console.warn("[admin/companies] list failed", error);
    return NextResponse.json({ error: "Failed to load companies" }, { status: 500 });
  }
}

// POST: create a new company (SuperAdmin only)
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (name.length > 200) return NextResponse.json({ error: "Name is too long" }, { status: 400 });

  const existing = await prisma.company.findUnique({ where: { name } });
  if (existing) return NextResponse.json({ error: "A company with that name already exists" }, { status: 409 });

  const created = await prisma.company.create({ data: { name } });
  return NextResponse.json(created, { status: 201 });
}
