import prisma from "@/lib/prisma";
import { DEFAULT_DATE_FORMAT, isDateFormat, type DateFormat } from "@/lib/date-format";

interface CachedSettings {
  dateFormat: DateFormat;
  loadedAt: number;
}

const CACHE_TTL_MS = 30_000;
let cache: CachedSettings | null = null;

async function loadFromDb(): Promise<DateFormat> {
  const row = await prisma.systemSetting.findUnique({ where: { id: 1 } });
  if (row && isDateFormat(row.dateFormat)) return row.dateFormat;
  return DEFAULT_DATE_FORMAT;
}

/** Read the system-wide default date format, with a short in-memory cache. */
export async function getSystemDateFormat(): Promise<DateFormat> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.dateFormat;
  }
  const dateFormat = await loadFromDb();
  cache = { dateFormat, loadedAt: Date.now() };
  return dateFormat;
}

/** Replace the system default and invalidate the cache. */
export async function setSystemDateFormat(format: DateFormat, updatedById?: number): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { id: 1 },
    update: { dateFormat: format, updatedById: updatedById ?? null },
    create: { id: 1, dateFormat: format, updatedById: updatedById ?? null },
  });
  cache = { dateFormat: format, loadedAt: Date.now() };
}

/** Used by tests / migrations to force a re-read on next access. */
export function invalidateSystemSettingsCache(): void {
  cache = null;
}
