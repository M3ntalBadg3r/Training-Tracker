/**
 * Validation and serving helpers for the uploaded branding images.
 *
 * The accepted type is decided by sniffing magic bytes, never by trusting the
 * browser-supplied `Content-Type` — a client can claim anything.
 *
 * SVG is deliberately not accepted. An SVG is not an image format in the sense
 * the other four are: it is an executable document that can carry <script>,
 * event-handler attributes and external references. These files are served
 * same-origin (`/api/branding/logo`), and the route is public and unauthenticated
 * so the login page can render before anyone signs in — so a stored SVG is a
 * document an attacker can navigate a victim straight to, in this app's origin,
 * with the session cookie in scope. That is a stored-XSS primitive, and a logo
 * is not worth it.
 *
 * Note what this reasoning deliberately does **not** rest on: the value of the
 * app's `script-src` directive. The ban is right because the app should not
 * need a CSP directive to stop it serving executable documents it accepted from
 * an upload form — defence in depth means the upload check stands on its own,
 * and a policy string is a thing a future release edits.
 *
 * The direction of travel is worth recording honestly, because it runs the
 * opposite way to the usual: today's policy carries `script-src 'self'
 * 'unsafe-inline'`, which is what lets a stored SVG's inline script execute at
 * all. A move to a per-request nonce + `strict-dynamic` would make that script
 * *inert* — no nonce can be attached to markup an attacker supplied. So
 * tightening `script-src` would relax the constraint here rather than add to
 * it. It still would not justify accepting SVG: the relief would be CSP-shaped
 * (it evaporates with the next policy edit, and it does nothing about SVG's
 * non-script surface), and nothing about a branding logo requires it.
 */

import { NextRequest, NextResponse } from "next/server";
import { getBrandingImage } from "@/lib/system-settings";

export type BrandingImageKind = "logo" | "favicon";

/** Raw byte caps, checked per file after decoding the multipart body. */
export const MAX_IMAGE_BYTES: Record<BrandingImageKind, number> = {
  logo: 512 * 1024,
  favicon: 128 * 1024,
};

/**
 * Ceiling on the whole request body. `formData()` buffers the entire upload
 * before any per-file size is visible, so this is checked from the
 * Content-Length header *before* parsing.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const ICO = [0x00, 0x00, 0x01, 0x00];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

function isWebp(bytes: Uint8Array): boolean {
  // "RIFF" .... "WEBP"
  if (bytes.length < 12) return false;
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}

/**
 * Identify an uploaded image from its content. Returns the MIME type to store,
 * or null when the bytes are not an accepted image for this kind.
 */
export function sniffImageMimeType(
  bytes: Uint8Array,
  kind: BrandingImageKind
): string | null {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, ICO)) return "image/x-icon";
  // A favicon is rendered at ~16px; JPEG and WebP are allowed for logos only,
  // where a photographic mark is plausible.
  if (kind === "logo") {
    if (startsWith(bytes, JPEG)) return "image/jpeg";
    if (isWebp(bytes)) return "image/webp";
  }
  return null;
}

/** Human-readable list of what each field accepts, for error messages. */
export const ACCEPTED_LABEL: Record<BrandingImageKind, string> = {
  logo: "PNG, JPEG, WebP or ICO",
  favicon: "PNG or ICO",
};

/**
 * Serve a stored branding image. Public (the login page needs it before the
 * user has authenticated) and immutably cacheable, which is safe because every
 * URL carries a `?v=<updatedAt>` cache-buster — browsers cache favicons far
 * more aggressively than any header suggests, so versioning the URL is the only
 * reliable way to bust them.
 */
export async function serveBrandingImage(
  request: NextRequest,
  kind: BrandingImageKind
): Promise<NextResponse> {
  const image = await getBrandingImage(kind);
  if (!image) {
    return new NextResponse(null, { status: 404 });
  }

  const etag = `W/"${kind}-${image.updatedAtMs}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  const bytes = Buffer.from(image.data, "base64");
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": image.mimeType,
      "Content-Length": String(bytes.byteLength),
      ETag: etag,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
