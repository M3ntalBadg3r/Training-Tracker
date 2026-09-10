/**
 * Single reader for the automatic-backup configuration (`.auto-backup.json`).
 *
 * Four routes used to read this file — `schedule`, `save`, `files` and
 * `restore-file` — three of them through verbatim copies of the same helper.
 * Only the route that *wrote* the file validated the directory, so the three
 * readers would have acted on any path that reached the file by another means.
 * The clamp therefore lives here, with the read, rather than at the write.
 */

import fs from "fs";
import path from "path";
import { appDir, backupRoot, resolveWithin } from "@/lib/safe-path";

export const BACKUP_CONFIG_FILENAME = ".auto-backup.json";

export interface AutoBackupConfig {
  enabled: boolean;
  frequency: "daily" | "weekly";
  time: string;
  dayOfWeek?: number;
  backupPath: string;
  retentionCount: number;
  // Whether scheduled archives carry password hashes / MFA secrets. Only
  // honoured when ENCRYPTION_KEY is set (see backup/save); without it a
  // restore of a scheduled backup cannot recreate user accounts.
  includeCredentials: boolean;
}

export function backupConfigPath(): string {
  return path.join(appDir(), BACKUP_CONFIG_FILENAME);
}

/** The directory backups land in when none has been configured. */
export function defaultBackupPath(): string {
  return backupRoot();
}

/**
 * Confine a configured backup directory to `backupRoot()`. An out-of-root value
 * falls back to the default rather than failing the backup outright — a backup
 * that still runs somewhere safe is better than one that silently stops.
 */
export function resolveBackupPath(candidate: unknown): string {
  const root = backupRoot();
  const resolved = resolveWithin(root, candidate, { allowBase: true });
  if (resolved) return resolved;

  if (candidate) {
    console.warn(
      `[backup] configured backup path is outside ${root}; falling back to the default. ` +
        `Set BACKUP_ROOT in .env to use a different location.`,
    );
  }
  return root;
}

export function readAutoBackupConfig(): AutoBackupConfig {
  const configPath = backupConfigPath();
  let stored: Partial<AutoBackupConfig> = {};

  if (fs.existsSync(configPath)) {
    try {
      stored = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      console.warn(`[backup] ${BACKUP_CONFIG_FILENAME} is not readable JSON; using defaults.`);
    }
  }

  return {
    enabled: stored.enabled === true,
    frequency: stored.frequency === "weekly" ? "weekly" : "daily",
    time: typeof stored.time === "string" ? stored.time : "02:00",
    dayOfWeek: stored.dayOfWeek !== undefined ? Number(stored.dayOfWeek) : 0,
    backupPath: resolveBackupPath(stored.backupPath),
    retentionCount: Math.max(1, Number(stored.retentionCount) || 5),
    // A config written before includeCredentials existed has no such key, and
    // an absent opt-in must read as "off" rather than undefined.
    includeCredentials: stored.includeCredentials === true,
  };
}

/** The confined backup directory, for callers that need only the path. */
export function getBackupPath(): string {
  return readAutoBackupConfig().backupPath;
}
