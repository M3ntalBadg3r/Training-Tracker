import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { exchangeCode, isCloudProvider } from "@/lib/oauth-providers";
import {
  verifyOAuthState,
  getRedirectUri,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_OPTIONS,
} from "@/lib/oauth-state";
import { sealConfig, openConfig } from "@/lib/crypto";

function htmlPage(opts: { provider: string; status: "ok" | "error"; message: string; nonce: string }): string {
  const payload = JSON.stringify({
    type: "tt-oauth",
    provider: opts.provider,
    status: opts.status,
    message: opts.message,
  });
  const heading = opts.status === "ok" ? "Connected" : "Connection failed";
  const colour = opts.status === "ok" ? "#16a34a" : "#dc2626";
  // The nonce comes from proxy.ts via the x-nonce request header and matches
  // the per-request CSP header so the inline <script> below is allowed.
  const nonceAttr = opts.nonce ? ` nonce="${opts.nonce}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${heading}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 480px; margin: 4rem auto; padding: 2rem; text-align: center; }
    h1 { color: ${colour}; }
    button { padding: 0.5rem 1rem; margin-top: 1.5rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>${heading}</h1>
  <p>${opts.message}</p>
  <p>You can close this window.</p>
  <button onclick="window.close()">Close window</button>
  <script${nonceAttr}>
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(${payload}, window.location.origin);
        setTimeout(function () { window.close(); }, 250);
      }
    } catch (e) {
      // Ignore — the user can close manually.
    }
  </script>
</body>
</html>`;
}

function htmlResponse(request: NextRequest, provider: string, status: "ok" | "error", message: string, code = 200): NextResponse {
  const nonce = request.headers.get("x-nonce") ?? "";
  const response = new NextResponse(htmlPage({ provider, status, message, nonce }), {
    status: code,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  // Always clear the one-shot state cookie.
  response.cookies.set(OAUTH_STATE_COOKIE, "", { ...OAUTH_STATE_COOKIE_OPTIONS, maxAge: 0 });
  return response;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;

  if (!isCloudProvider(provider)) {
    return htmlResponse(request, provider, "error", "Unknown provider.", 400);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const errorDesc = url.searchParams.get("error_description");

  if (errorParam) {
    return htmlResponse(request, provider, "error", errorDesc || errorParam, 400);
  }
  if (!code || !state) {
    return htmlResponse(request, provider, "error", "Missing 'code' or 'state' from provider.", 400);
  }

  const stateCookie = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!stateCookie || stateCookie !== state) {
    return htmlResponse(request, provider, "error", "State mismatch — please retry the connection from Training Tracker.", 400);
  }
  const verified = await verifyOAuthState(stateCookie, provider);
  if (!verified) {
    return htmlResponse(request, provider, "error", "State token invalid or expired — please retry.", 400);
  }

  const cred = await prisma.exportCredential.findUnique({ where: { provider } });
  if (!cred) {
    return htmlResponse(request, provider, "error", "No pending credential found. Please retry from Training Tracker.", 400);
  }

  let pendingConfig: Record<string, unknown>;
  try {
    pendingConfig = openConfig(cred.config);
  } catch {
    return htmlResponse(request, provider, "error", "Stored credential could not be decrypted (encryption key missing or rotated).", 500);
  }
  const clientId = typeof pendingConfig.clientId === "string" ? pendingConfig.clientId : "";
  const clientSecret = typeof pendingConfig.clientSecret === "string" ? pendingConfig.clientSecret : "";
  if (!clientId || !clientSecret) {
    return htmlResponse(request, provider, "error", "Pending credential is missing Client ID or Secret.", 400);
  }

  const redirectUri = getRedirectUri(request, provider);
  try {
    const tokens = await exchangeCode({
      provider,
      code,
      clientId,
      clientSecret,
      redirectUri,
      tenantId: typeof pendingConfig.tenantId === "string" ? pendingConfig.tenantId : undefined,
    });

    const finalConfig: Record<string, unknown> = {
      clientId,
      clientSecret,
      refreshToken: tokens.refreshToken,
    };
    if (typeof pendingConfig.tenantId === "string") finalConfig.tenantId = pendingConfig.tenantId;
    if (typeof pendingConfig.folderId === "string") finalConfig.folderId = pendingConfig.folderId;
    if (typeof pendingConfig.folderPath === "string") finalConfig.folderPath = pendingConfig.folderPath;

    const now = new Date();
    const sealed = sealConfig(finalConfig);
    await prisma.exportCredential.update({
      where: { provider },
      data: {
        config: sealed as object,
        lastSuccessAt: now,
        lastCheckedAt: now,
        lastCheckStatus: "ok",
        lastCheckError: null,
      },
    });

    return htmlResponse(request, provider, "ok", "Training Tracker is now connected.");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token exchange failed";
    return htmlResponse(request, provider, "error", message, 400);
  }
}
