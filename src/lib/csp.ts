/**
 * Content-Security-Policy construction, in one place.
 *
 * This module deliberately has **no imports at all**, the same constraint as
 * `lib/roles.ts` and for the same reason twice over: `proxy.ts` builds the
 * policy per request and runs in the **edge** runtime, and `next.config.ts`
 * builds the static variant for the handful of paths the proxy's matcher
 * excludes. Neither can reach a module that pulls in Node built-ins or Prisma,
 * and a policy that exists in two hand-maintained copies is a policy that will
 * drift. Anything added here must keep that property.
 *
 * ## Scope: this is `script-src` only
 *
 * `style-src 'unsafe-inline'` is NOT removed here and cannot be, so do not read
 * the nonce work below as inline styles having been hardened. The root layout
 * renders `<html style={…}>` for the brand colour and `force-dynamic`
 * serialises it into the initial HTML as a literal `style="…"` attribute — and
 * **a style attribute cannot carry a nonce**. `HelpModal` ships an inline
 * `<style>` element, several components set `style={{…}}` props (`BrandMark`
 * does it unconditionally, on the login page), and Recharts sets inline styles
 * on its own containers at runtime throughout the reports. Removing
 * `style-src 'unsafe-inline'` is a separate, larger piece of work.
 *
 * ## The three modes
 *
 * A policy that contains a nonce makes browsers ignore `'unsafe-inline'`
 * entirely (CSP2 §7.4.1, carried into CSP3). There is therefore no intermediate
 * state where a nonce is present *and* `'unsafe-inline'` still acts as a safety
 * net — "mint a nonce" and "drop `'unsafe-inline'`" are one change, and the only
 * real gate is which mode is the default.
 *
 *  - `legacy`      — today's policy, byte for byte. No nonce is minted.
 *  - `report-only` — the strict policy is sent as
 *                    `Content-Security-Policy-Report-Only` **and nothing is
 *                    enforced**. Read that twice: this mode does NOT keep the
 *                    legacy policy enforced alongside the report, so while it
 *                    is on, `frame-ancestors`, `object-src` and every other
 *                    directive stop being enforced too. It is forced rather
 *                    than chosen — the reason is spelled out where the headers
 *                    are assembled in `proxy.ts` — and it makes this a short
 *                    diagnostic window for finding out *which* script broke,
 *                    never a resting state. To run with reduced risk, use
 *                    `legacy`, which really does enforce.
 *  - `enforce`     — the strict policy is the enforced one. `'unsafe-inline'`
 *                    is gone from `script-src`.
 *
 * The mode is read from the `CSP_MODE` environment variable. It exists because
 * this app can update itself unattended, and a CSP mistake does not degrade
 * gracefully — it white-screens a page that still answers HTTP 200. An operator
 * needs a way back that does not involve editing code.
 */

export type CspMode = "legacy" | "report-only" | "enforce";

export const CSP_MODES: readonly CspMode[] = ["legacy", "report-only", "enforce"];

/**
 * The mode used when `CSP_MODE` is unset or unrecognised.
 *
 * This single constant is the whole behavioural switch. Changing it changes what
 * every install does by default, so it is deliberately the only thing that has
 * to move to go from "all the machinery is in place, nothing has changed" to
 * "the strict policy is live".
 */
export const DEFAULT_CSP_MODE: CspMode = "legacy";

/**
 * Parse a `CSP_MODE` value. Unknown values fall back to the default rather than
 * throwing: this runs in edge middleware on every request, and a typo in the
 * environment should not take the site down — the whole point of the setting is
 * to be a way out of trouble, not a new way into it.
 */
export function resolveCspMode(raw: string | null | undefined): CspMode {
  const value = (raw ?? "").trim().toLowerCase();
  return (CSP_MODES as readonly string[]).includes(value)
    ? (value as CspMode)
    : DEFAULT_CSP_MODE;
}

/**
 * Shape of a base64 nonce, matching the subset of Next's own
 * `CSP_NONCE_SOURCE_REGEX` that `generateNonce` can actually produce.
 *
 * Used to validate a nonce read back out of a request header before it is
 * interpolated into a policy string or an HTML attribute. The proxy overwrites
 * that header on every path it handles, so a forged value should never arrive —
 * this is the second lock, for the day someone adds a sixth pass-through.
 */
export const NONCE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A fresh per-request nonce: 16 random bytes, base64.
 *
 * Web Crypto and `btoa` are globals in both the edge runtime and Node, which is
 * what keeps this module import-free. 16 bytes is the size CSP3 recommends as a
 * minimum; the value must be unguessable, because a nonce an attacker can
 * predict is exactly equivalent to `'unsafe-inline'`.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The paths the proxy's `matcher` excludes, and therefore the exact set
 * `next.config.ts` has to cover instead.
 *
 * These two lists have to be **equal**, not merely overlapping, and getting that
 * wrong is silent in both directions: a path in both places gets two
 * `Content-Security-Policy` response headers and a browser enforces their
 * *intersection*; a path in neither gets no policy at all. The first shipped
 * version of this had the second bug — the matcher excludes by **regex prefix**
 * while the config entries were written as path-to-regexp exact/sub-path
 * sources, so everything in the gap (`/_next/staticx/a.js`, `/favicon.icox`,
 * `/_next/image/`, …) fell through both and was served with no policy.
 *
 * They are expressed here as regex **prefix** fragments, matching the matcher's
 * own semantics, and `staticAssetHeaderSources()` wraps them in the
 * path-to-regexp custom-regex form `next.config.ts` needs. Note the escaped dot:
 * the matcher's original `favicon.ico` had a bare `.`, which is a wildcard, so
 * it also excluded `/faviconXico`. Escaping it narrows the exclusion — those
 * paths now go through the proxy and get their policy there, which is the safe
 * direction.
 *
 * **`proxy.ts`'s `matcher` must be kept in step by hand.** Next requires that
 * value to be a statically analysable literal, so it cannot import this — the
 * literal there is `"/((?!_next/static|_next/image|favicon\.ico).*)"` and the
 * alternation inside it is exactly this list.
 */
export const STATIC_ASSET_PREFIXES: readonly string[] = [
  "_next/static",
  "_next/image",
  "favicon\\.ico",
];

/**
 * `STATIC_ASSET_PREFIXES` as `next.config.ts` header `source` patterns.
 *
 * `/:path(<regex>)` is Next's escape hatch for a custom regex in a source, and
 * because the fragment ends in `.*` it matches the rest of the path including
 * slashes — the same prefix match the matcher performs. That is what makes the
 * two exhaustive rather than approximately aligned.
 */
export function staticAssetHeaderSources(): string[] {
  return STATIC_ASSET_PREFIXES.map((prefix) => `/:path(${prefix}.*)`);
}

export interface BuildCspOptions {
  /**
   * The per-request nonce, or null for a response that is not an HTML document
   * (an API payload, a static asset, a redirect). A nonce only means anything
   * to a document, and baking a per-request value into a header on a cacheable
   * response is a bug waiting to be found.
   */
  nonce?: string | null;
  /** Strict (nonce-based) `script-src` rather than `'unsafe-inline'`. */
  strict: boolean;
  /** Development build — relaxes `script-src` enough for HMR. */
  isDev: boolean;
}

/**
 * Build a complete policy string.
 *
 * Only `script-src` varies; every other directive is identical across all three
 * modes, which is what makes `legacy` byte-identical to what shipped before
 * this module existed.
 */
export function buildCsp(options: BuildCspOptions): string {
  const { nonce = null, strict, isDev } = options;

  const scriptSrc: string[] = [];
  if (strict) {
    if (nonce) {
      scriptSrc.push(`'nonce-${nonce}'`);
      // 'strict-dynamic' lets a nonce-approved script load further scripts —
      // which is how the App Router's bootstrap pulls in its chunks. Without it
      // every chunk would need its own nonce, which nothing stamps.
      scriptSrc.push("'strict-dynamic'");
    }
    // 'self' is kept DELIBERATELY and is not redundant. A CSP3 browser ignores
    // host-source expressions once 'strict-dynamic' is present, so this costs
    // nothing there — but a browser that understands nonces and *not*
    // 'strict-dynamic' falls back to this, and without it same-origin chunks
    // would be refused and the page would render as a blank shell. It is the
    // documented fallback for exactly that case. Do not delete it as dead.
    scriptSrc.push("'self'");
    // No nonce means this is not a document: 'self' alone is the honest policy.
    // 'strict-dynamic' without a nonce is not a loosening, it is a total denial,
    // so it is omitted rather than left dangling.
    if (isDev) scriptSrc.push("'unsafe-eval'");
  } else {
    scriptSrc.push("'self'");
    if (isDev) scriptSrc.push("'unsafe-eval'");
    // The directive this whole exercise exists to remove: it executes any
    // <script> block that appears in the document, whatever put it there.
    scriptSrc.push("'unsafe-inline'");
  }

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    // Not moving — see the note at the top of this file.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}
