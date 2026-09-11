import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { openConfig, sealConfig } from "@/lib/crypto";
import { readJsonBody } from "@/lib/request-body";
import {
  fieldsFor,
  validateCredentialConfig,
  VALID_PROVIDERS,
} from "@/lib/credential-config";

/**
 * Per-provider field classification, default-deny — see `lib/credential-config.ts`.
 *
 * The table used to live here and cover the read side only. It replaced a single
 * `SENSITIVE_KEYS` **denylist** applied to an untyped `Record<string, unknown>`.
 * A denylist over an open-ended blob fails open: any key not on it was returned
 * verbatim to the client, so the four names happened to cover the shapes of the
 * day and would have covered nothing added later.
 *
 * `publicKeys` is the whole of what GET may return; anything else in the stored
 * blob is dropped whether or not we recognise it. `secretKeys` is what the
 * client is told *exists* (never its value), and is the same set the POST uses
 * for blank-means-keep — the two must stay in step, or a key missing from one is
 * echoed by GET and silently wiped by the next POST that omits it.
 *
 * The table now also drives the **write** schema, which is why it moved into a
 * lib: there is no longer a version of "which keys exist" that only one side
 * knows about.
 *
 * `clientId` is classified with the secrets rather than as public. It is not a
 * secret in the OAuth sense, but nothing reads it back: the credential wizard
 * starts from an empty field and the inline form exists only for `email`. So
 * returning it buys nothing, and default-deny is the point of the rewrite.
 */

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

  // Content-type check, size cap and 400-on-malformed, instead of a bare
  // request.json() whose reject surfaced as an opaque 500.
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  try {
    const { provider, config } = parsed.body ?? {};

    if (!provider || typeof provider !== "string" || !VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }

    // Validate before the spread: what follows seals whatever it is handed, and
    // these values become an outbound connection and a provider URL.
    const validated = validateCredentialConfig(provider, config);
    if ("error" in validated) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    // Preserve existing sensitive fields if the incoming value is blank
    const mergedConfig: Record<string, unknown> = { ...validated.config };
    const existing = await prisma.exportCredential.findUnique({ where: { provider } });
    if (existing) {
      const old = openConfig(existing.config) as Record<string, unknown>;
      // Blank means keep — the client never receives a secret's value, so it
      // cannot send it back. Same list GET uses for `hasSecrets`.
      for (const key of fieldsFor(provider).secretKeys) {
        if (!mergedConfig[key] && old[key]) mergedConfig[key] = old[key];
      }
    }

    // Re-validate the merged object, because the merged object is what is
    // actually sealed: the blank-means-keep step pulls values out of a blob that
    // may predate this check, so validating only the request body would leave a
    // stored value no one had ever looked at.
    const merged = validateCredentialConfig(provider, mergedConfig);
    if ("error" in merged) {
      return NextResponse.json({ error: merged.error }, { status: 400 });
    }

    const sealed = sealConfig(merged.config);
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
