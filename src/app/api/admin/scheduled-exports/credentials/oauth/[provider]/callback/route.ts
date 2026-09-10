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
import { requireAuth } from "@/lib/auth";

/**
 * Escape text for interpolation into HTML element content.
 *
 * This is the only hand-built HTML in the app — everywhere else React escapes
 * for us — so the usual safety net does not apply here.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialise a value for embedding in an inline <script> block.
 *
 * JSON.stringify alone is NOT safe here: it leaves `<` untouched, so a string
 * containing `</script>` closes the block and everything after it is parsed as
 * markup. U+2028/U+2029 are valid in JSON strings but are line terminators in
 * JavaScript source, so they are escaped too.
 */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// The provider never gets to choose the words we render. Its own
// `error_description` is logged server-side and replaced with one of these, so
// no provider- or attacker-supplied text ever reaches the page (Round 1 item 7:
// generic error messages).
const GENERIC_PROVIDER_ERROR =
  "The provider refused the connection. Check the Client ID and Secret, then retry from Training Tracker.";
const GENERIC_EXCHANGE_ERROR =
  "Could not complete the connection with the provider. Please retry from Training Tracker.";

function htmlPage(opts: { provider: string; status: "ok" | "error"; message: string }): string {
  const payload = scriptSafeJson({
    type: "tt-oauth",
    provider: opts.provider,
    status: opts.status,
    message: opts.message,
  });
  const heading = opts.status === "ok" ? "Connected" : "Connection failed";
  const safeMessage = escapeHtml(opts.message);
  const colour = opts.status === "ok" ? "#16a34a" : "#dc2626";
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
  <p>${safeMessage}</p>
  <p>You can close this window.</p>
  <button onclick="window.close()">Close window</button>
  <script>
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

function htmlResponse(provider: string, status: "ok" | "error", message: string, code = 200): NextResponse {
  const response = new NextResponse(htmlPage({ provider, status, message }), {
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

  // Guard in the handler, not just at the edge (Round 1 item 3: every handler
  // carries its own guard). This route renders HTML and the auth cookie is
  // SameSite=Lax, so it is reachable by a cross-site top-level navigation —
  // the proxy's role check alone is a single point of failure, and it cannot
  // see a since-disabled account. requireAuth covers both.
  try {
    await requireAuth(request, "Admin");
  } catch {
    return htmlResponse(
      provider,
      "error",
      "You need to be signed in to Training Tracker to finish connecting.",
      401,
    );
  }

  if (!isCloudProvider(provider)) {
    return htmlResponse(provider, "error", "Unknown provider.", 400);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const errorDesc = url.searchParams.get("error_description");

  if (errorParam) {
    // Never echo the provider's text back into the page — it is fully
    // attacker-controlled and this branch runs before any state validation.
    console.warn(
      `[oauth] ${provider} returned an error: ${errorParam}` +
        (errorDesc ? ` (${errorDesc})` : ""),
    );
    return htmlResponse(provider, "error", GENERIC_PROVIDER_ERROR, 400);
  }
  if (!code || !state) {
    return htmlResponse(provider, "error", "Missing 'code' or 'state' from provider.", 400);
  }

  const stateCookie = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!stateCookie || stateCookie !== state) {
    return htmlResponse(provider, "error", "State mismatch — please retry the connection from Training Tracker.", 400);
  }
  const verified = await verifyOAuthState(stateCookie, provider);
  if (!verified) {
    return htmlResponse(provider, "error", "State token invalid or expired — please retry.", 400);
  }

  const cred = await prisma.exportCredential.findUnique({ where: { provider } });
  if (!cred) {
    return htmlResponse(provider, "error", "No pending credential found. Please retry from Training Tracker.", 400);
  }

  let pendingConfig: Record<string, unknown>;
  try {
    pendingConfig = openConfig(cred.config);
  } catch {
    return htmlResponse(provider, "error", "Stored credential could not be decrypted (encryption key missing or rotated).", 500);
  }
  const clientId = typeof pendingConfig.clientId === "string" ? pendingConfig.clientId : "";
  const clientSecret = typeof pendingConfig.clientSecret === "string" ? pendingConfig.clientSecret : "";
  if (!clientId || !clientSecret) {
    return htmlResponse(provider, "error", "Pending credential is missing Client ID or Secret.", 400);
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

    return htmlResponse(provider, "ok", "Training Tracker is now connected.");
  } catch (err) {
    // The upstream failure text can carry internal hostnames and token-endpoint
    // responses; keep it in the server log and show the operator a fixed string.
    console.warn(`[oauth] ${provider} token exchange failed:`, err);
    return htmlResponse(provider, "error", GENERIC_EXCHANGE_ERROR, 400);
  }
}
