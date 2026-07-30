import prisma from "@/lib/prisma";
import { DEFAULT_DATE_FORMAT, isDateFormat, type DateFormat } from "@/lib/date-format";

/** Bounds for the configurable idle-session timeout (minutes). */
export const MIN_SESSION_IDLE_MINUTES = 5;
export const MAX_SESSION_IDLE_MINUTES = 1440; // 24h
export const DEFAULT_SESSION_IDLE_MINUTES = 30;

/** The public API ships disabled — it must be switched on deliberately. */
export const DEFAULT_PUBLIC_API_ENABLED = false;

interface CachedSettings {
  dateFormat: DateFormat;
  sessionIdleMinutes: number;
  publicApiEnabled: boolean;
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

async function loadFromDb(): Promise<Omit<CachedSettings, "loadedAt">> {
  const row = await prisma.systemSetting.findUnique({ where: { id: 1 } });
  return {
    dateFormat: row && isDateFormat(row.dateFormat) ? row.dateFormat : DEFAULT_DATE_FORMAT,
    sessionIdleMinutes: clampSessionIdleMinutes(
      row?.sessionIdleMinutes ?? DEFAULT_SESSION_IDLE_MINUTES
    ),
    publicApiEnabled: row?.publicApiEnabled ?? DEFAULT_PUBLIC_API_ENABLED,
  };
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
function cacheRow(row: {
  dateFormat: string;
  sessionIdleMinutes: number;
  publicApiEnabled: boolean;
}): void {
  cache = {
    dateFormat: isDateFormat(row.dateFormat) ? row.dateFormat : DEFAULT_DATE_FORMAT,
    sessionIdleMinutes: clampSessionIdleMinutes(row.sessionIdleMinutes),
    publicApiEnabled: row.publicApiEnabled,
    loadedAt: Date.now(),
  };
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
  });
  cacheRow(row);
  return row.publicApiEnabled;
}

/** Used by tests / migrations to force a re-read on next access. */
export function invalidateSystemSettingsCache(): void {
  cache = null;
}
