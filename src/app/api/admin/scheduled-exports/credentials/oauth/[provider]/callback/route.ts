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
import { NONCE_PATTERN } from "@/lib/csp";

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

/**
 * Render the popup page the provider redirects back to.
 *
 * This is the only hand-built HTML in the app, so it is also the only place
 * that has to think about the Content-Security-Policy by hand. Two rules shape
 * the markup below — the first about `script-src`, the second about `style-src`:
 *
 *  - **No inline event handlers.** `onclick="…"` is covered by `'unsafe-inline'`
 *    and by nothing else — a nonce cannot apply to an attribute, and a hash
 *    only reaches one with `'unsafe-hashes'`. Under a tightened policy the
 *    handler would simply never run, and the failure is silent: the button
 *    renders, the user clicks, nothing happens, and no message reaches them.
 *    The click is therefore wired with `addEventListener` from inside the
 *    <script> block, which a nonce *can* cover.
 *
 *    **This route stamps its own nonce.** It hand-builds a NextResponse rather
 *    than going through the React render path, so nothing stamps one for it —
 *    the value is read back from the `x-nonce` request header the proxy sets
 *    (see `readNonce` below) and written onto the <script> tag by hand. Under a
 *    nonce-only `script-src` the block would otherwise be refused as a whole
 *    and this page would silently lose both the auto-close and the button.
 *
 *  - **The <style> block is static.** The old block interpolated
 *    `h1 { color: ${colour} }`. `colour` was a two-literal union, so that was
 *    hashable in principle — two `sha256-` entries — but awkward and fragile:
 *    every edit to the block silently invalidates the pinned hashes, and the
 *    count grows with the states. One static block is one hash
 *    (`sha256-lnIrPltkLoQVOmLsunLOWQAS1dkf2bcIZYmak+8dBmo=` at the time of
 *    writing) and is simpler markup regardless of any policy.
 *
 * Keeping the block hashable is housekeeping, not a step towards dropping
 * `style-src 'unsafe-inline'` — that is not going anywhere app-wide. `src/`
 * carries eight inline `style={…}` attributes, and a style *attribute* cannot
 * take a nonce. The one in the root layout (`<html style={…}>`, the brand
 * colour) is conditional on a branded install, but `BrandMark` renders
 * `style={{ height: size }}` unconditionally on the login page, and Recharts
 * sets inline styles on its own containers at runtime throughout the reports.
 */
/**
 * The per-request nonce, from the header `src/proxy.ts` forwards.
 *
 * Validated rather than trusted. The proxy clears any caller-supplied `x-nonce`
 * on every path it handles, so a forged value should never reach here — but
 * this value is interpolated straight into an HTML attribute, and a header that
 * is *usually* sanitised upstream is exactly the kind of assumption that stops
 * being true when someone adds a new pass-through branch. Anything that is not
 * plain base64 is dropped, which costs this page its script (under a strict
 * policy it would have been refused anyway) rather than opening an injection.
 *
 * Empty string when the policy is in legacy mode and no nonce exists — the
 * attribute is then omitted entirely rather than emitted blank, because
 * `nonce=""` is a source expression that matches nothing.
 */
function readNonce(request: NextRequest): string {
  const value = request.headers.get("x-nonce") ?? "";
  return NONCE_PATTERN.test(value) ? value : "";
}

function htmlPage(opts: { provider: string; status: "ok" | "error"; message: string; nonce: string }): string {
  const payload = scriptSafeJson({
    type: "tt-oauth",
    provider: opts.provider,
    status: opts.status,
    message: opts.message,
  });
  const heading = opts.status === "ok" ? "Connected" : "Connection failed";
  const safeMessage = escapeHtml(opts.message);
  // A literal, not interpolated data: the two arms are the only values this can
  // ever take, so the class attribute needs no escaping.
  const statusClass = opts.status === "ok" ? "ok" : "err";
  // Already validated as base64 by readNonce, so it needs no escaping.
  const nonceAttr = opts.nonce ? ` nonce="${opts.nonce}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${heading}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 480px; margin: 4rem auto; padding: 2rem; text-align: center; }
    body.ok h1 { color: #16a34a; }
    body.err h1 { color: #dc2626; }
    button { padding: 0.5rem 1rem; margin-top: 1.5rem; cursor: pointer; }
  </style>
</head>
<body class="${statusClass}">
  <h1>${heading}</h1>
  <p>${safeMessage}</p>
  <p>You can close this window.</p>
  <button id="tt-close-window" type="button">Close window</button>
  <script${nonceAttr}>
    (function () {
      function wireClose() {
        var button = document.getElementById("tt-close-window");
        if (button) {
          button.addEventListener("click", function () { window.close(); });
        }
      }
      // An inline script at the end of the document body runs *during*
      // parsing, so readyState is "loading" here and the DOMContentLoaded
      // branch is the one actually taken: the click listener is registered
      // after the try/catch below has already run, not before it. Measured,
      // not assumed — the listener lands at readyState "interactive".
      //
      // That ordering is fine, and the two reasons are worth stating because
      // they are what a future edit could break. Nothing before the
      // registration can throw past it (the catch swallows the postMessage
      // path entirely), and this page has no subresources, so
      // DOMContentLoaded fires immediately after parsing — long before a user
      // can click. Keep it that way: if this block ever grows code that can
      // throw *outside* that catch, move the wiring ahead of it, because the
      // manual close is the fallback for when the postMessage path fails and
      // must not depend on it.
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", wireClose);
      } else {
        wireClose();
      }
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(${payload}, window.location.origin);
          setTimeout(function () { window.close(); }, 250);
        }
      } catch (e) {
        // Ignore — the user can close manually.
      }
    })();
  </script>
</body>
</html>`;
}

function htmlResponse(
  provider: string,
  status: "ok" | "error",
  message: string,
  nonce: string,
  code = 200,
): NextResponse {
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
  const nonce = readNonce(request);
  // Every exit from this handler renders the same popup, so bind the two
  // per-request values once rather than threading them through eleven call
  // sites — a nonce that one error branch quietly forgot would be a dead
  // button on exactly the path where the user most needs the message.
  const page = (status: "ok" | "error", message: string, code = 200) =>
    htmlResponse(provider, status, message, nonce, code);

  // Guard in the handler, not just at the edge (Round 1 item 3: every handler
  // carries its own guard). This route renders HTML and the auth cookie is
  // SameSite=Lax, so it is reachable by a cross-site top-level navigation —
  // the proxy's role check alone is a single point of failure, and it cannot
  // see a since-disabled account. requireAuth covers both.
  try {
    await requireAuth(request, "Admin");
  } catch {
    return page(
      "error",
      "You need to be signed in to Training Tracker to finish connecting.",
      401,
    );
  }

  if (!isCloudProvider(provider)) {
    return page("error", "Unknown provider.", 400);
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
    return page("error", GENERIC_PROVIDER_ERROR, 400);
  }
  if (!code || !state) {
    return page("error", "Missing 'code' or 'state' from provider.", 400);
  }

  const stateCookie = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!stateCookie || stateCookie !== state) {
    return page("error", "State mismatch — please retry the connection from Training Tracker.", 400);
  }
  const verified = await verifyOAuthState(stateCookie, provider);
  if (!verified) {
    return page("error", "State token invalid or expired — please retry.", 400);
  }

  const cred = await prisma.exportCredential.findUnique({ where: { provider } });
  if (!cred) {
    return page("error", "No pending credential found. Please retry from Training Tracker.", 400);
  }

  let pendingConfig: Record<string, unknown>;
  try {
    pendingConfig = openConfig(cred.config);
  } catch {
    return page("error", "Stored credential could not be decrypted (encryption key missing or rotated).", 500);
  }
  const clientId = typeof pendingConfig.clientId === "string" ? pendingConfig.clientId : "";
  const clientSecret = typeof pendingConfig.clientSecret === "string" ? pendingConfig.clientSecret : "";
  if (!clientId || !clientSecret) {
    return page("error", "Pending credential is missing Client ID or Secret.", 400);
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

    return page("ok", "Training Tracker is now connected.");
  } catch (err) {
    // The upstream failure text can carry internal hostnames and token-endpoint
    // responses; keep it in the server log and show the operator a fixed string.
    console.warn(`[oauth] ${provider} token exchange failed:`, err);
    return page("error", GENERIC_EXCHANGE_ERROR, 400);
  }
}
