import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";

const KEY_INCLUDE = {
  companies: { select: { company: { select: { id: true, name: true } } } },
} as const;

function serializeKey(key: {
  id: number;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  companies: { company: { id: number; name: string } }[];
}) {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    enabled: key.enabled,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    lastUsedIp: key.lastUsedIp,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
    companies: key.companies.map((c) => c.company),
  };
}

// PATCH: rename, enable/disable, revoke, edit company grants, or set/clear expiry.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const keyId = parseInt(id, 10);
  if (Number.isNaN(keyId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const existing = await prisma.apiKey.findUnique({ where: { id: keyId } });
  if (!existing) return NextResponse.json({ error: "API key not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const { name, enabled, revoked, companyIds, expiresAt } = body as {
    name?: string;
    enabled?: boolean;
    revoked?: boolean;
    companyIds?: number[];
    expiresAt?: string | null;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = {};

  if (typeof name === "string" && name.trim()) data.name = name.trim();
  if (typeof enabled === "boolean") data.enabled = enabled;

  // Revocation is one-way and also disables the key.
  if (revoked === true) {
    data.revokedAt = new Date();
    data.enabled = false;
  }

  if (expiresAt !== undefined) {
    if (expiresAt === null || expiresAt === "") {
      data.expiresAt = null;
    } else {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ error: "Invalid expiry date" }, { status: 400 });
      }
      data.expiresAt = parsed;
    }
  }

  const replaceCompanies = Array.isArray(companyIds);
  let ids: number[] = [];
  if (replaceCompanies) {
    ids = (companyIds as number[]).filter((n) => Number.isInteger(n));
    if (ids.length === 0) {
      return NextResponse.json(
        { error: "A key must be scoped to at least one company" },
        { status: 400 }
      );
    }
    const found = await prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true } });
    if (found.length !== ids.length) {
      return NextResponse.json({ error: "One or more companies not found" }, { status: 400 });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.apiKey.update({ where: { id: keyId }, data });
    }
    if (replaceCompanies) {
      await tx.apiKeyCompany.deleteMany({ where: { apiKeyId: keyId } });
      await tx.apiKeyCompany.createMany({
        data: ids.map((cid) => ({ apiKeyId: keyId, companyId: cid })),
        skipDuplicates: true,
      });
    }
    return tx.apiKey.findUnique({ where: { id: keyId }, include: KEY_INCLUDE });
  });

  return NextResponse.json(serializeKey(updated!));
}

// DELETE: permanently remove an API key (cascades its company grants).
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const keyId = parseInt(id, 10);
  if (Number.isNaN(keyId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 });

  const existing = await prisma.apiKey.findUnique({ where: { id: keyId } });
  if (!existing) return NextResponse.json({ error: "API key not found" }, { status: 404 });

  await prisma.apiKey.delete({ where: { id: keyId } });
  return NextResponse.json({ success: true });
}
