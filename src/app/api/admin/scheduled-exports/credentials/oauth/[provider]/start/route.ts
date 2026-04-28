import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  buildAuthUrl,
  isCloudProvider,
  PROVIDER_CONFIG,
} from "@/lib/oauth-providers";
import {
  signOAuthState,
  getRedirectUri,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_OPTIONS,
} from "@/lib/oauth-state";

interface StartBody {
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  folderId?: string;
  folderPath?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { provider } = await params;
  if (!isCloudProvider(provider)) {
    return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }

  const body = (await request.json()) as StartBody;
  if (!body.clientId || !body.clientSecret) {
    return NextResponse.json(
      { error: "clientId and clientSecret are required" },
      { status: 400 },
    );
  }

  const cfg = PROVIDER_CONFIG[provider];
  const redirectUri = getRedirectUri(request, provider);
  const state = await signOAuthState(provider);

  // Stash the pending Client ID/Secret + folder + tenant info on the credential
  // row so the callback can finish the exchange. Marked pending:true so a
  // half-completed flow doesn't masquerade as a working credential.
  const pendingConfig: Record<string, unknown> = {
    clientId: body.clientId,
    clientSecret: body.clientSecret,
    pending: true,
  };
  if (cfg.needsTenantId) {
    pendingConfig.tenantId = body.tenantId?.trim() || "common";
  }
  if (cfg.folderField === "folderId" && body.folderId) {
    pendingConfig.folderId = body.folderId;
  }
  if (cfg.folderField === "folderPath" && body.folderPath) {
    pendingConfig.folderPath = body.folderPath;
  }

  // Preserve refreshToken from a prior successful connect so a cancelled
  // wizard doesn't accidentally wipe a working credential.
  const existing = await prisma.exportCredential.findUnique({ where: { provider } });
  if (existing) {
    const existingConfig = existing.config as Record<string, unknown>;
    if (typeof existingConfig.refreshToken === "string") {
      pendingConfig.previousRefreshToken = existingConfig.refreshToken;
    }
  }

  await prisma.exportCredential.upsert({
    where: { provider },
    update: { config: pendingConfig as object },
    create: { provider, config: pendingConfig as object },
  });

  const authUrl = buildAuthUrl({
    provider,
    clientId: body.clientId,
    redirectUri,
    state,
    tenantId: cfg.needsTenantId ? (body.tenantId?.trim() || "common") : undefined,
  });

  const response = NextResponse.json({ authUrl, redirectUri });
  response.cookies.set(OAUTH_STATE_COOKIE, state, OAUTH_STATE_COOKIE_OPTIONS);
  return response;
}
