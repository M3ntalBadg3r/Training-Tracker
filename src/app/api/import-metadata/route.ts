import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany } from "@/lib/company-scope";

/**
 * "Last imported" timestamps, one row per import type.
 *
 * Two shapes of key: a global one (`students`, `training-data`, …) and a
 * per-company one (`students:<companyId>`, `offerings:<companyId>`) written by
 * the company-scoped importers. See the ImportMetadata key convention in
 * CLAUDE.md.
 *
 * This route sits outside `/api/admin/`, so `proxy.ts` applies no role gate to
 * it — `isAdminPath` matches only `/admin` and `/api/admin`. Its own
 * `requireAuth` takes no role either, so *any* authenticated user reaches it,
 * including a read-only `User`. That is fine for the global keys (a timestamp,
 * on data everyone in the app can already see) but not for the per-company
 * ones: an unscoped lookup let a caller probe `?key=students:<id>` for a
 * company they have no access to and learn, from a non-null response, that the
 * company exists and when it was last imported. Company ids are sequential, so
 * that enumerates the tenant list.
 */

/** `students:12` → 12. Null for a global key, or a suffix that isn't an id. */
function companyIdFromKey(key: string): number | null {
  const separator = key.lastIndexOf(":");
  if (separator === -1) return null;
  const suffix = key.slice(separator + 1);
  // Deliberately strict: only an all-digits suffix is treated as a company id.
  // A key that merely contains a colon must not silently read as global.
  if (!/^\d+$/.test(suffix)) return null;
  const id = Number(suffix);
  return Number.isSafeInteger(id) ? id : null;
}

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const key = request.nextUrl.searchParams.get("key");

  if (key) {
    const companyId = companyIdFromKey(key);
    if (companyId !== null && !(await canAccessCompany(auth.sub, auth.role, companyId))) {
      // Same answer as "this company has never been imported", so the response
      // cannot distinguish a company that is out of scope from one that does
      // not exist. The client renders a null body as a blank timestamp, which
      // is exactly what an in-scope company with no import returns.
      return NextResponse.json(null);
    }
    const record = await prisma.importMetadata.findUnique({ where: { key } });
    return NextResponse.json(record);
  }

  // No key: the unfiltered list would hand back every `<type>:<companyId>` row
  // at once, enumerating every company that has ever been imported. No caller
  // in the app uses this branch — all nine pass `?key=` — so it returns only
  // the global rows rather than growing a scope-aware variant nothing wants.
  const records = await prisma.importMetadata.findMany();
  return NextResponse.json(records.filter((r) => companyIdFromKey(r.key) === null));
}
