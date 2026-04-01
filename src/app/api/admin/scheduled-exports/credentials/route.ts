import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import prisma from "@/lib/prisma";

const VALID_PROVIDERS = ["email", "google-drive", "box", "onedrive"];
const SENSITIVE_KEYS = ["password", "clientSecret", "refreshToken", "accessToken"];

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const credentials = await prisma.exportCredential.findMany();
  // Return non-sensitive config fields; indicate which sensitive fields are set
  const configured = credentials.map((c: typeof credentials[number]) => {
    const cfg = c.config as Record<string, unknown>;
    const publicConfig: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (!SENSITIVE_KEYS.includes(k)) publicConfig[k] = v;
    }
    return {
      provider: c.provider,
      updatedAt: c.updatedAt,
      config: publicConfig,
      hasSecrets: SENSITIVE_KEYS.filter((k) => cfg[k]),
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
    const mergedConfig: Record<string, string | boolean> = { ...config };
    const existing = await prisma.exportCredential.findUnique({ where: { provider } });
    if (existing) {
      const old = existing.config as Record<string, string | boolean>;
      for (const key of SENSITIVE_KEYS) {
        if (!mergedConfig[key] && old[key]) mergedConfig[key] = old[key];
      }
    }

    const record = await prisma.exportCredential.upsert({
      where: { provider },
      create: { provider, config: mergedConfig },
      update: { config: mergedConfig },
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
