import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { readJsonBody } from "@/lib/request-body";
import { invalidateReportCache } from "@/lib/report-cache";
import {
  COUNTRY_SET_SELECT,
  DUPLICATE_NAME_RESPONSE,
  isUniqueViolation,
  nameTaken,
  parseCountrySetBody,
  toCountrySetRow,
} from "../route";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const NOT_FOUND = () => NextResponse.json({ error: "Country set not found" }, { status: 404 });

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const setId = parseId((await params).id);
  if (setId === null) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const validated = await parseCountrySetBody(parsed.body, { partial: true });
  if (!validated.ok) return validated.response;
  const { name, description, countries } = validated.input;

  const existing = await prisma.countrySet.findUnique({ where: { id: setId }, select: { id: true } });
  if (!existing) return NOT_FOUND();
  if (await nameTaken(name, setId)) return DUPLICATE_NAME_RESPONSE();

  try {
    // An absent `description`/`countries` key (undefined) leaves that value
    // alone. When `countries` is sent, members are replaced wholesale inside
    // one transaction, so a failure part-way can never leave half the old set.
    const updated = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await tx.countrySet.update({
        where: { id: setId },
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
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const setId = parseId((await params).id);
  if (setId === null) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  try {
    // Members go with the set (ON DELETE CASCADE). Program requirements are
    // not tied to a particular set — the Country Set level applies to
    // whichever set is viewed — so nothing else references it.
    const result = await prisma.countrySet.deleteMany({ where: { id: setId } });
    if (result.count === 0) return NOT_FOUND();
    invalidateReportCache();
    return NextResponse.json({ success: true });
  } catch (err) {
    console.warn("country-sets DELETE failed", err);
    return NextResponse.json({ error: "Could not delete the country set" }, { status: 500 });
  }
}
