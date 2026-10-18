import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany } from "@/lib/company-scope";
import { readJsonBody } from "@/lib/request-body";
import { invalidateReportCache } from "@/lib/report-cache";
import {
  PROGRAM_COMPANY_SETTING_SELECT,
  parsePositiveId,
  parseSettingBody,
  toSettingRow,
} from "../route";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const NOT_FOUND = () => NextResponse.json({ error: "Partner settings not found" }, { status: 404 });

/**
 * Load a row's owning company and confirm the caller may act on it. A row in a
 * company the caller cannot access answers exactly like a row that does not
 * exist (`null` → the same 404): a 403 would confirm the id belongs to another
 * tenant and turn sequential ids into an enumeration oracle.
 */
async function loadAccessibleSetting(
  auth: { sub: number; role: string },
  id: number
): Promise<{ id: number; programId: number; companyId: number } | null> {
  const row = await prisma.programCompanySetting.findUnique({
    where: { id },
    select: { id: true, programId: true, companyId: true },
  });
  if (!row) return null;
  if (!(await canAccessCompany(auth.sub, auth.role, row.companyId))) return null;
  return row;
}

/**
 * PUT /api/admin/program-company-settings/[id] — partial update. An absent
 * `countrySetMinimumCountries` / `countrySetId` / `targetMinimumCountries` /
 * `targetCountrySetId` key leaves that value alone; an explicit `null` (or
 * `""`) clears it. Either set must belong to the row's own company. `programId` and `companyId` are
 * immutable: a body naming a different one is a 400 rather than silently
 * ignored, so a client that thinks it moved a row is told it did not.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const parsed = await readJsonBody(request, 64 * 1024);
  if (!parsed.ok) return parsed.response;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const body = parsed.body as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;

  const existing = await loadAccessibleSetting(auth, id);
  if (!existing) return NOT_FOUND();

  if (has("companyId") && parsePositiveId(body.companyId) !== existing.companyId) {
    return NextResponse.json({ error: "A partner setting's company cannot be changed" }, { status: 400 });
  }
  if (has("programId") && parsePositiveId(body.programId) !== existing.programId) {
    return NextResponse.json({ error: "A partner setting's program cannot be changed" }, { status: 400 });
  }

  const fields = await parseSettingBody(body, existing.companyId);
  if (!fields.ok) return NextResponse.json({ error: fields.error }, { status: 400 });
  const data = fields.value;

  try {
    // Pinned to the access-checked company, so even a concurrent change cannot
    // move the write onto another tenant's row.
    const updated = await prisma.programCompanySetting.update({
      where: { id, companyId: existing.companyId },
      data,
      select: PROGRAM_COMPANY_SETTING_SELECT,
    });
    invalidateReportCache();
    return NextResponse.json(toSettingRow(updated));
  } catch (err) {
    if ((err as { code?: unknown })?.code === "P2025") return NOT_FOUND();
    console.warn("program-company-settings PUT failed", err);
    return NextResponse.json({ error: "Could not update the partner settings" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  try {
    const existing = await loadAccessibleSetting(auth, id);
    if (!existing) return NOT_FOUND();
    const result = await prisma.programCompanySetting.deleteMany({
      where: { id, companyId: existing.companyId },
    });
    if (result.count === 0) return NOT_FOUND();
    invalidateReportCache();
    return NextResponse.json({ success: true });
  } catch (err) {
    console.warn("program-company-settings DELETE failed", err);
    return NextResponse.json({ error: "Could not delete the partner settings" }, { status: 500 });
  }
}
