import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { openConfig, sealConfig } from "@/lib/crypto";

/**
 * Per-provider field classification, default-deny.
 *
 * This replaced a single `SENSITIVE_KEYS` **denylist** applied to an untyped
 * `Record<string, unknown>`. A denylist over an open-ended blob fails open: any
 * key not on it was returned verbatim to the client, so the four names happened
 * to cover today's shapes and would have covered nothing added later. `config`
 * is whatever the POST body carried — there is no schema on the write side — so
 * "added later" includes a key an admin or a client bug simply invents.
 *
 * `publicKeys` is now the whole of what GET may return; anything else in the
 * stored blob is dropped whether or not we recognise it. `secretKeys` is what
 * the client is told *exists* (never its value), and is the same set the POST
 * uses for blank-means-keep — the two must stay in step, or a key missing from
 * one is echoed by GET and silently wiped by the next POST that omits it.
 *
 * `clientId` is classified with the secrets rather than as public. It is not a
 * secret in the OAuth sense, but nothing reads it back: the credential wizard
 * starts from an empty field and the inline form exists only for `email`. So
 * returning it buys nothing, and default-deny is the point of the rewrite.
 */
const PROVIDER_FIELDS: Record<string, { publicKeys: string[]; secretKeys: string[] }> = {
  email: {
    publicKeys: ["host", "port", "secure", "user", "from"],
    secretKeys: ["password"],
  },
  "google-drive": {
    publicKeys: ["folderId"],
    secretKeys: ["clientId", "clientSecret", "refreshToken", "accessToken"],
  },
  box: {
    publicKeys: ["folderId"],
    secretKeys: ["clientId", "clientSecret", "refreshToken", "accessToken"],
  },
  onedrive: {
    publicKeys: ["folderPath", "tenantId"],
    secretKeys: ["clientId", "clientSecret", "refreshToken", "accessToken"],
  },
};

const VALID_PROVIDERS = Object.keys(PROVIDER_FIELDS);

/** An unknown provider cannot reach the write paths, but read defensively. */
function fieldsFor(provider: string): { publicKeys: string[]; secretKeys: string[] } {
  return PROVIDER_FIELDS[provider] ?? { publicKeys: [], secretKeys: [] };
}

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const credentials = await prisma.exportCredential.findMany();
  // Return non-sensitive config fields; indicate which sensitive fields are set
  const configured = credentials.map((c: typeof credentials[number]) => {
    let cfg: Record<string, unknown> = {};
    try {
      cfg = openConfig(c.config);
    } catch {
      // Decryption failure (missing/rotated key, corrupt blob): treat as "no
      // public config visible" but still surface the row so the admin can
      // re-save it. Mark hasSecrets empty.
      return {
        provider: c.provider,
        updatedAt: c.updatedAt,
        config: {},
        hasSecrets: [],
        decryptError: true,
      };
    }
    const { publicKeys, secretKeys } = fieldsFor(c.provider);
    const publicConfig: Record<string, unknown> = {};
    for (const key of publicKeys) {
      if (key in cfg) publicConfig[key] = cfg[key];
    }
    return {
      provider: c.provider,
      updatedAt: c.updatedAt,
      config: publicConfig,
      hasSecrets: secretKeys.filter((k) => cfg[k]),
    };
  });
  return NextResponse.json(configured);
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const body = await request.json();
    const { provider, config } = body;

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    if (!config || typeof config !== "object") {
      return NextResponse.json({ error: "Missing config" }, { status: 400 });
    }

    // Preserve existing sensitive fields if the incoming value is blank
    const mergedConfig: Record<string, unknown> = { ...config };
    const existing = await prisma.exportCredential.findUnique({ where: { provider } });
    if (existing) {
      const old = openConfig(existing.config) as Record<string, unknown>;
      // Blank means keep — the client never receives a secret's value, so it
      // cannot send it back. Same list GET uses for `hasSecrets`.
      for (const key of fieldsFor(provider).secretKeys) {
        if (!mergedConfig[key] && old[key]) mergedConfig[key] = old[key];
      }
    }

    const sealed = sealConfig(mergedConfig);
    const record = await prisma.exportCredential.upsert({
      where: { provider },
      create: { provider, config: sealed as object },
      update: { config: sealed as object },
    });

    return NextResponse.json({ success: true, provider: record.provider, updatedAt: record.updatedAt });
  } catch {
    return NextResponse.json({ error: "Failed to save credentials" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    await prisma.exportCredential.delete({ where: { provider } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete credentials" }, { status: 500 });
  }
}
