import { NextRequest, NextResponse } from "next/server";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import {
  getBranding,
  setBranding,
  isBrandColor,
  MAX_APP_NAME_LENGTH,
  DEFAULT_APP_NAME,
  type BrandingPatch,
} from "@/lib/system-settings";
import {
  ACCEPTED_LABEL,
  MAX_IMAGE_BYTES,
  MAX_UPLOAD_BYTES,
  sniffImageMimeType,
  type BrandingImageKind,
} from "@/lib/branding-image";

/** Current branding, minus the image bytes (the client only needs presence). */
async function readBranding() {
  const brand = await getBranding();
  return {
    appName: brand.appName,
    brandColor: brand.brandColor,
    hasLogo: brand.logoMimeType !== null,
    hasFavicon: brand.faviconMimeType !== null,
    loginShowName: brand.loginShowName,
    loginShowLogo: brand.loginShowLogo,
    updatedAtMs: brand.updatedAtMs,
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  return NextResponse.json(await readBranding());
}

/** Strip control characters and collapse whitespace in a submitted app name. */
function normaliseAppName(raw: string): string {
  return raw.replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Read one uploaded image field, validating it by content rather than by the
 * client-declared type. Returns `null` to leave the current image alone,
 * `"clear"` to remove it, the bytes to store, or an error response.
 */
async function readImageField(
  form: FormData,
  kind: BrandingImageKind
): Promise<
  | { value: null | "clear" | { data: string; mimeType: string } }
  | { error: NextResponse }
> {
  if (form.get(kind === "logo" ? "removeLogo" : "removeFavicon") === "true") {
    return { value: "clear" };
  }

  const file = form.get(kind);
  if (!(file instanceof File) || file.size === 0) return { value: null };

  if (file.size > MAX_IMAGE_BYTES[kind]) {
    return {
      error: NextResponse.json(
        {
          error: `The ${kind} must be ${Math.round(MAX_IMAGE_BYTES[kind] / 1024)} KB or smaller.`,
        },
        { status: 413 }
      ),
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = sniffImageMimeType(bytes, kind);
  if (!mimeType) {
    return {
      error: NextResponse.json(
        {
          error: `That file isn't a supported image. The ${kind} must be ${ACCEPTED_LABEL[kind]} (SVG isn't accepted).`,
        },
        { status: 400 }
      ),
    };
  }

  return { value: { data: Buffer.from(bytes).toString("base64"), mimeType } };
}

export async function PUT(request: NextRequest) {
  let auth;
  try {
    auth = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  // Checked before formData(), which buffers the whole body into memory — a
  // per-file size check afterwards would be too late to protect against it.
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "Upload too large" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const patch: BrandingPatch = {};

  const appName = form.get("appName");
  if (typeof appName === "string") {
    const cleaned = normaliseAppName(appName);
    if (!cleaned) {
      return NextResponse.json({ error: "Name can't be empty" }, { status: 400 });
    }
    if (cleaned.length > MAX_APP_NAME_LENGTH) {
      return NextResponse.json(
        { error: `Name must be ${MAX_APP_NAME_LENGTH} characters or fewer` },
        { status: 400 }
      );
    }
    patch.appName = cleaned;
  }

  const brandColor = form.get("brandColor");
  if (typeof brandColor === "string") {
    if (brandColor === "") {
      patch.brandColor = null;
    } else if (isBrandColor(brandColor)) {
      patch.brandColor = brandColor.toLowerCase();
    } else {
      return NextResponse.json(
        { error: "Brand colour must be a hex value like #2563eb" },
        { status: 400 }
      );
    }
  }

  for (const key of ["loginShowName", "loginShowLogo"] as const) {
    const value = form.get(key);
    if (typeof value === "string") patch[key] = value === "true";
  }

  const logo = await readImageField(form, "logo");
  if ("error" in logo) return logo.error;
  if (logo.value === "clear") {
    patch.logoData = null;
    patch.logoMimeType = null;
  } else if (logo.value) {
    patch.logoData = logo.value.data;
    patch.logoMimeType = logo.value.mimeType;
  }

  const favicon = await readImageField(form, "favicon");
  if ("error" in favicon) return favicon.error;
  if (favicon.value === "clear") {
    patch.faviconData = null;
    patch.faviconMimeType = null;
  } else if (favicon.value) {
    patch.faviconData = favicon.value.data;
    patch.faviconMimeType = favicon.value.mimeType;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No settings provided" }, { status: 400 });
  }

  await setBranding(patch, auth.sub);
  return NextResponse.json(await readBranding());
}

/** Reset every branding field back to the stock product identity. */
export async function DELETE(request: NextRequest) {
  let auth;
  try {
    auth = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  await setBranding(
    {
      appName: DEFAULT_APP_NAME,
      brandColor: null,
      logoData: null,
      logoMimeType: null,
      faviconData: null,
      faviconMimeType: null,
      loginShowName: true,
      loginShowLogo: true,
    },
    auth.sub
  );
  return NextResponse.json(await readBranding());
}
