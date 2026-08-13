import prisma from "@/lib/prisma";
import { DEFAULT_DATE_FORMAT, isDateFormat, type DateFormat } from "@/lib/date-format";

/** Bounds for the configurable idle-session timeout (minutes). */
export const MIN_SESSION_IDLE_MINUTES = 5;
export const MAX_SESSION_IDLE_MINUTES = 1440; // 24h
export const DEFAULT_SESSION_IDLE_MINUTES = 30;

/** The public API ships disabled — it must be switched on deliberately. */
export const DEFAULT_PUBLIC_API_ENABLED = false;

/** Product name shown when no branding has been configured. */
export const DEFAULT_APP_NAME = "Training Tracker";

/** Longest permitted custom app name — the sidebar rail is only 14rem wide. */
export const MAX_APP_NAME_LENGTH = 60;

const BRAND_COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * A brand colour is fed straight into `color-mix()` in globals.css. An invalid
 * value makes every one of those declarations invalid-at-computed-value-time,
 * which would leave the whole blue palette unset — so validate strictly and
 * reject rather than coerce.
 */
export function isBrandColor(value: unknown): value is string {
  return typeof value === "string" && BRAND_COLOR_RE.test(value);
}

/**
 * Columns making up the cached settings row. Deliberately omits `logoData` and
 * `faviconData`: those are hundreds of KB of base64 and this row is read on hot
 * paths (every date format lookup). The image routes select them on their own.
 */
const SETTINGS_SELECT = {
  dateFormat: true,
  sessionIdleMinutes: true,
  publicApiEnabled: true,
  appName: true,
  brandColor: true,
  logoMimeType: true,
  faviconMimeType: true,
  loginShowName: true,
  loginShowLogo: true,
  showNameInTab: true,
  updatedAt: true,
} as const;

type SettingsRow = {
  dateFormat: string;
  sessionIdleMinutes: number;
  publicApiEnabled: boolean;
  appName: string;
  brandColor: string | null;
  logoMimeType: string | null;
  faviconMimeType: string | null;
  loginShowName: boolean;
  loginShowLogo: boolean;
  showNameInTab: boolean;
  updatedAt: Date;
};

/** The branding subset, as consumed by the layout and the login page. */
export interface Branding {
  appName: string;
  brandColor: string | null;
  logoMimeType: string | null;
  faviconMimeType: string | null;
  loginShowName: boolean;
  loginShowLogo: boolean;
  /** When false the page renders no <title> and the browser shows the URL. */
  showNameInTab: boolean;
  /** Drives the `?v=` cache-buster on the image URLs. */
  updatedAtMs: number;
}

export const BRANDING_DEFAULTS: Branding = {
  appName: DEFAULT_APP_NAME,
  brandColor: null,
  logoMimeType: null,
  faviconMimeType: null,
  loginShowName: true,
  loginShowLogo: true,
  showNameInTab: true,
  updatedAtMs: 0,
};

interface CachedSettings {
  dateFormat: DateFormat;
  sessionIdleMinutes: number;
  publicApiEnabled: boolean;
  branding: Branding;
  loadedAt: number;
}

const CACHE_TTL_MS = 30_000;
let cache: CachedSettings | null = null;

/** Clamp an arbitrary value to the supported idle-timeout range. */
export function clampSessionIdleMinutes(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_SESSION_IDLE_MINUTES;
  return Math.min(MAX_SESSION_IDLE_MINUTES, Math.max(MIN_SESSION_IDLE_MINUTES, n));
}

/** Normalise a stored (or just-upserted) row into the cached shape. */
function toSettings(row: SettingsRow | null): Omit<CachedSettings, "loadedAt"> {
  return {
    dateFormat: row && isDateFormat(row.dateFormat) ? row.dateFormat : DEFAULT_DATE_FORMAT,
    sessionIdleMinutes: clampSessionIdleMinutes(
      row?.sessionIdleMinutes ?? DEFAULT_SESSION_IDLE_MINUTES
    ),
    publicApiEnabled: row?.publicApiEnabled ?? DEFAULT_PUBLIC_API_ENABLED,
    branding: row
      ? {
          appName: row.appName?.trim() || DEFAULT_APP_NAME,
          brandColor: isBrandColor(row.brandColor) ? row.brandColor.toLowerCase() : null,
          logoMimeType: row.logoMimeType,
          faviconMimeType: row.faviconMimeType,
          loginShowName: row.loginShowName,
          loginShowLogo: row.loginShowLogo,
          showNameInTab: row.showNameInTab,
          updatedAtMs: row.updatedAt.getTime(),
        }
      : BRANDING_DEFAULTS,
  };
}

async function loadFromDb(): Promise<Omit<CachedSettings, "loadedAt">> {
  const row = await prisma.systemSetting.findUnique({
    where: { id: 1 },
    select: SETTINGS_SELECT,
  });
  return toSettings(row);
}

async function getCached(): Promise<CachedSettings> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  const loaded = await loadFromDb();
  cache = { ...loaded, loadedAt: Date.now() };
  return cache;
}

/**
 * Refresh the whole cache from a just-upserted row. Every setter goes through
 * this so adding a field can't leave one setter silently resetting it.
 */
function cacheRow(row: SettingsRow): void {
  cache = { ...toSettings(row), loadedAt: Date.now() };
}

/** Read the system-wide default date format, with a short in-memory cache. */
export async function getSystemDateFormat(): Promise<DateFormat> {
  return (await getCached()).dateFormat;
}

/** Replace the system default and invalidate the cache. */
export async function setSystemDateFormat(format: DateFormat, updatedById?: number): Promise<void> {
  const row = await prisma.systemSetting.upsert({
    where: { id: 1 },
    update: { dateFormat: format, updatedById: updatedById ?? null },
    create: { id: 1, dateFormat: format, updatedById: updatedById ?? null },
    select: SETTINGS_SELECT,
  });
  cacheRow(row);
}

/** Read the system-wide idle-session timeout (minutes), with a short cache. */
export async function getSessionIdleMinutes(): Promise<number> {
  return (await getCached()).sessionIdleMinutes;
}

/** Replace the idle-session timeout and invalidate the cache. */
export async function setSessionIdleMinutes(minutes: number, updatedById?: number): Promise<number> {
  const clamped = clampSessionIdleMinutes(minutes);
  const row = await prisma.systemSetting.upsert({
    where: { id: 1 },
    update: { sessionIdleMinutes: clamped, updatedById: updatedById ?? null },
    create: { id: 1, sessionIdleMinutes: clamped, updatedById: updatedById ?? null },
    select: SETTINGS_SELECT,
  });
  cacheRow(row);
  return clamped;
}

/**
 * Read the global public-API switch, with a short cache. When false every
 * `/api/public/v1/*` endpoint refuses the request regardless of key status.
 */
export async function getPublicApiEnabled(): Promise<boolean> {
  return (await getCached()).publicApiEnabled;
}

/** Turn the public API on or off system-wide and refresh the cache. */
export async function setPublicApiEnabled(
  enabled: boolean,
  updatedById?: number
): Promise<boolean> {
  const row = await prisma.systemSetting.upsert({
    where: { id: 1 },
    update: { publicApiEnabled: enabled, updatedById: updatedById ?? null },
    create: { id: 1, publicApiEnabled: enabled, updatedById: updatedById ?? null },
    select: SETTINGS_SELECT,
  });
  cacheRow(row);
  return row.publicApiEnabled;
}

/**
 * Read the white-label branding. Deliberately NOT served from the 30s settings
 * cache.
 *
 * Route handlers and server components are bundled separately, so they hold
 * separate module instances of this file — meaning the `cacheRow` refresh that
 * `setBranding` performs updates the API route's copy while the root layout's
 * copy stays stale for the rest of the TTL. Branding is the one setting whose
 * change the admin expects to see on the very next page load, so "save, reload,
 * nothing happened" is not an acceptable trade for a cached read.
 *
 * The cost is one single-row primary-key lookup per server render, on a narrow
 * projection that excludes the image blobs. That is far cheaper than the paths
 * the cache exists to protect (`getSystemDateFormat` runs in many API routes;
 * this runs on document loads).
 */
export async function getBranding(): Promise<Branding> {
  const row = await prisma.systemSetting.findUnique({
    where: { id: 1 },
    select: SETTINGS_SELECT,
  });
  return toSettings(row).branding;
}

/**
 * Branding read that can never throw. The root layout calls this on every
 * render and `generateMetadata` calls it during `next build`, so a database
 * that is unreachable (or not yet migrated) must degrade to the stock branding
 * rather than fail the page or the build.
 */
export async function getBrandingSafe(): Promise<Branding> {
  try {
    return await getBranding();
  } catch {
    return BRANDING_DEFAULTS;
  }
}

/** The fields `setBranding` accepts. Omitted keys are left untouched. */
export type BrandingPatch = Partial<{
  appName: string;
  brandColor: string | null;
  logoData: string | null;
  logoMimeType: string | null;
  faviconData: string | null;
  faviconMimeType: string | null;
  loginShowName: boolean;
  loginShowLogo: boolean;
  showNameInTab: boolean;
}>;

/** Apply a partial branding update and refresh the cache. */
export async function setBranding(
  patch: BrandingPatch,
  updatedById?: number
): Promise<Branding> {
  const data = { ...patch, updatedById: updatedById ?? null };
  const row = await prisma.systemSetting.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, ...data },
    select: SETTINGS_SELECT,
  });
  cacheRow(row);
  return toSettings(row).branding;
}

/**
 * Fetch one branding image's bytes. Uncached and narrowly selected — the blobs
 * are deliberately kept out of the shared settings cache.
 */
export async function getBrandingImage(
  kind: "logo" | "favicon"
): Promise<{ data: string; mimeType: string; updatedAtMs: number } | null> {
  if (kind === "logo") {
    const row = await prisma.systemSetting.findUnique({
      where: { id: 1 },
      select: { logoData: true, logoMimeType: true, updatedAt: true },
    });
    if (!row?.logoData || !row.logoMimeType) return null;
    return {
      data: row.logoData,
      mimeType: row.logoMimeType,
      updatedAtMs: row.updatedAt.getTime(),
    };
  }

  const row = await prisma.systemSetting.findUnique({
    where: { id: 1 },
    select: { faviconData: true, faviconMimeType: true, updatedAt: true },
  });
  if (!row?.faviconData || !row.faviconMimeType) return null;
  return {
    data: row.faviconData,
    mimeType: row.faviconMimeType,
    updatedAtMs: row.updatedAt.getTime(),
  };
}

/** Used by tests / migrations to force a re-read on next access. */
export function invalidateSystemSettingsCache(): void {
  cache = null;
}
