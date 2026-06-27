import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { generateApiKey } from "@/lib/api-key";

// Shape returned to the admin UI. Never includes the hash or the plaintext key.
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

const KEY_INCLUDE = {
  companies: { select: { company: { select: { id: true, name: true } } } },
} as const;

// GET: list all API keys with their company grants.
export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const keys = await prisma.apiKey.findMany({
    orderBy: { createdAt: "desc" },
    include: KEY_INCLUDE,
  });

  return NextResponse.json(keys.map(serializeKey));
}

// POST: create a new API key. Returns the plaintext key ONCE in the response.
export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json().catch(() => ({}));
  const { name, companyIds, expiresAt } = body as {
    name?: string;
    companyIds?: number[];
    expiresAt?: string | null;
  };

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "A name is required" }, { status: 400 });
  }

  const ids = Array.isArray(companyIds) ? companyIds.filter((n) => Number.isInteger(n)) : [];
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "Select at least one company the key can read" },
      { status: 400 }
    );
  }

  const found = await prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true } });
  if (found.length !== ids.length) {
    return NextResponse.json({ error: "One or more companies not found" }, { status: 400 });
  }

  let expiry: Date | null = null;
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "Invalid expiry date" }, { status: 400 });
    }
    expiry = parsed;
  }

  const generated = generateApiKey();

  const created = await prisma.apiKey.create({
    data: {
      name: name.trim(),
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      expiresAt: expiry,
      createdById: auth.sub,
      companies: { create: ids.map((cid) => ({ companyId: cid })) },
    },
    include: KEY_INCLUDE,
  });

  // The plaintext is returned exactly once — it is never stored or retrievable.
  return NextResponse.json(
    { ...serializeKey(created), plaintextKey: generated.plaintext },
    { status: 201 }
  );
}
