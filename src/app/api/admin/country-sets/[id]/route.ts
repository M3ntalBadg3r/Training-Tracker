import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany } from "@/lib/company-scope";
import { readJsonBody } from "@/lib/request-body";
import { invalidateReportCache } from "@/lib/report-cache";
import {
  COUNTRY_SET_SELECT,
  DUPLICATE_NAME_RESPONSE,
  isUniqueViolation,
  nameTaken,
  parseCompanyId,
  parseCountrySetBody,
  toCountrySetRow,
} from "../route";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const NOT_FOUND = () => NextResponse.json({ error: "Country set not found" }, { status: 404 });

/**
 * Load a set's owning company and confirm the caller may act on it.
 *
 * A set in a company the caller cannot access answers exactly like a set that
 * does not exist (`null` → the same 404). A 403 there would confirm that the id
 * belongs to another tenant, turning sequential ids into an enumeration oracle.
 */
async function loadAccessibleSet(
  auth: { sub: number; role: string },
  setId: number
): Promise<{ id: number; companyId: number } | null> {
  const row = await prisma.countrySet.findUnique({
    where: { id: setId },
    select: { id: true, companyId: true },
  });
  if (!row) return null;
  if (!(await canAccessCompany(auth.sub, auth.role, row.companyId))) return null;
  return row;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const setId = parseId((await params).id);
  if (setId === null) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  const existing = await loadAccessibleSet(auth, setId);
  if (!existing) return NOT_FOUND();

  // The owning company is immutable. An absent key (or the same company) is
  // fine; anything else is refused rather than silently ignored, so a client
  // that believes it moved a set is told it did not.
  if (parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body)) {
    const b = parsed.body as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(b, "companyId") && b.companyId !== undefined) {
      if (parseCompanyId(b.companyId) !== existing.companyId) {
        return NextResponse.json(
          { error: "A country set's company cannot be changed" },
          { status: 400 }
        );
      }
    }
  }

  const validated = await parseCountrySetBody(parsed.body, { partial: true });
  if (!validated.ok) return validated.response;
  const { name, description, countries } = validated.input;

  if (await nameTaken(existing.companyId, name, setId)) return DUPLICATE_NAME_RESPONSE();

  try {
    // An absent `description`/`countries` key (undefined) leaves that value
    // alone. When `countries` is sent, members are replaced wholesale inside
    // one transaction, so a failure part-way can never leave half the old set.
    // `companyId` is never written here — the update is pinned to the row's own
    // company, so even a concurrent change cannot re-home it.
    const updated = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await tx.countrySet.update({
        where: { id: setId, companyId: existing.companyId },
        data: { name, ...(description !== undefined ? { description } : {}) },
      });
      if (countries !== undefined) {
        await tx.countrySetMember.deleteMany({ where: { countrySetId: setId } });
        if (countries.length > 0) {
          await tx.countrySetMember.createMany({
            data: countries.map((country) => ({ countrySetId: setId, country })),
          });
        }
      }
      return tx.countrySet.findUniqueOrThrow({ where: { id: setId }, select: COUNTRY_SET_SELECT });
    });
    invalidateReportCache();
    return NextResponse.json(toCountrySetRow(updated));
  } catch (err) {
    if (isUniqueViolation(err)) return DUPLICATE_NAME_RESPONSE();
    if ((err as { code?: unknown })?.code === "P2025") return NOT_FOUND();
    console.warn("country-sets PUT failed", err);
    return NextResponse.json({ error: "Could not update the country set" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const setId = parseId((await params).id);
  if (setId === null) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  try {
    const existing = await loadAccessibleSet(auth, setId);
    if (!existing) return NOT_FOUND();

    // Members go with the set (ON DELETE CASCADE). Program requirements are
    // not tied to a particular set — the Country Set level applies to
    // whichever set is viewed — so nothing else references it. The delete is
    // pinned to the company that was access-checked above.
    const result = await prisma.countrySet.deleteMany({
      where: { id: setId, companyId: existing.companyId },
    });
    if (result.count === 0) return NOT_FOUND();
    invalidateReportCache();
    return NextResponse.json({ success: true });
  } catch (err) {
    console.warn("country-sets DELETE failed", err);
    return NextResponse.json({ error: "Could not delete the country set" }, { status: 500 });
  }
}
