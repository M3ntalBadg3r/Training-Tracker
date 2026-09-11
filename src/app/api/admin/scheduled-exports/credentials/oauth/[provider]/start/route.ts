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
import { sealConfig, openConfig } from "@/lib/crypto";
import { readJsonBody } from "@/lib/request-body";
import { tenantIdProblem, validateCredentialConfig } from "@/lib/credential-config";

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

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = (parsed.body ?? {}) as StartBody;
  if (!body.clientId || !body.clientSecret) {
    return NextResponse.json(
      { error: "clientId and clientSecret are required" },
      { status: 400 },
    );
  }

  const cfg = PROVIDER_CONFIG[provider];

  // The tenant ID is interpolated into the provider's authorize/token URL by
  // `oauth-providers.ts` before `new URL` parses it, so a `/`, `?`, `#` or `..`
  // reshapes the request path rather than sitting in it as a value. Checked here
  // as well as in the credentials POST because this route is the other door the
  // same value comes through.
  const tenantId = cfg.needsTenantId ? (body.tenantId?.trim() || "common") : undefined;
  const tenantProblem = tenantId === undefined ? null : tenantIdProblem(tenantId);
  if (tenantProblem) {
    return NextResponse.json({ error: tenantProblem }, { status: 400 });
  }

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
  if (tenantId !== undefined) {
    pendingConfig.tenantId = tenantId;
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
    try {
      const existingConfig = openConfig(existing.config);
      if (typeof existingConfig.refreshToken === "string") {
        pendingConfig.previousRefreshToken = existingConfig.refreshToken;
      }
    } catch {
      // Existing blob can't be decrypted (e.g. wrong key); ignore and let
      // the new flow overwrite it.
    }
  }

  // Run the same write schema the credentials POST does. This object is
  // server-assembled from a fixed key set so the unknown-key class cannot arise
  // here, but the *values* are all client-supplied and this is the object that
  // gets sealed — validating it keeps the two write paths from diverging.
  // `allowInternal` because `pending`/`previousRefreshToken` are ours, not the
  // client's: they are not accepted from a request body anywhere.
  const validated = validateCredentialConfig(provider, pendingConfig, { allowInternal: true });
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const sealed = sealConfig(validated.config);
  await prisma.exportCredential.upsert({
    where: { provider },
    update: { config: sealed as object },
    create: { provider, config: sealed as object },
  });

  const authUrl = buildAuthUrl({
    provider,
    clientId: body.clientId,
    redirectUri,
    state,
    tenantId,
  });

  const response = NextResponse.json({ authUrl, redirectUri });
  response.cookies.set(OAUTH_STATE_COOKIE, state, OAUTH_STATE_COOKIE_OPTIONS);
  return response;
}
