/**
 * Filesystem path containment for admin-supplied directories.
 *
 * Several admin features let a user nominate a directory the server will write
 * to: scheduled exports (`ScheduledExport.config.path`) and the automatic-backup
 * location. Those values reach `mkdirSync`, `writeFileSync` and `unlinkSync`, so
 * they must be confined to a root the *operator* controls — not the admin. A
 * company Admin can edit a schedule; only whoever owns `.env` can move the root.
 *
 * This module is server-only (it touches `fs`). Never import it from a `"use
 * client"` component — API responses carry the root to the UI instead.
 */

import fs from "fs";
import path from "path";

/**
 * The application directory. `process.cwd()` is the app dir in every supported
 * deployment: the systemd unit sets `WorkingDirectory=/opt/training-tracker`
 * and the init.d fallback `cd`s there before `npm start`. The rest of the app
 * already anchors on it (the backup and update routes read their state files
 * this way).
 */
export function appDir(): string {
  return process.cwd();
}

/**
 * Resolve `base` to a canonical absolute path.
 *
 * `realpath` matters here: `path.resolve` is purely lexical, so if the app
 * directory (or a parent) is itself a symlink, a candidate resolved from a
 * symlink-free string would not match the base and legitimate paths would be
 * rejected. When the directory does not exist yet — the fresh-install case for
 * `exports/` — fall back to the lexical form; it is created on first use.
 */
function canonicalBase(dir: string): string {
  try {
    return fs.realpathSync(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Resolve `candidate` against `base` and return it only if it stays inside.
 * Returns null when it escapes, so callers must handle the rejection.
 *
 * A relative candidate is resolved against the base, so `"monthly"` is simply a
 * sub-folder; an absolute one resolves to itself and is then checked.
 *
 * The containment test is segment-aware. A plain `startsWith(base)` would accept
 * `/opt/training-tracker-evil` for a base of `/opt/training-tracker` — this is
 * the same shape of check `proxy.ts` uses for its SuperAdmin path prefixes.
 *
 * Symlinks *inside* the root are not resolved. Doing so would be a TOCTOU race
 * against the check, and planting one already requires shell access as the
 * service account, at which point containment is moot.
 */
export function resolveWithin(
  base: string,
  candidate: unknown,
  options: { allowBase?: boolean } = {},
): string | null {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("\0")) return null;

  const root = canonicalBase(base);
  const resolved = path.resolve(root, trimmed);

  if (resolved === root) return options.allowBase ? resolved : null;
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * Root for scheduled exports delivered to the local filesystem.
 *
 * Defaults to `<app dir>/exports`, which is the path this feature has always
 * defaulted to in production. Set `EXPORT_ROOT` to deliver somewhere else — and
 * on a systemd host, add a matching `ReadWritePaths=` drop-in, or the sandbox
 * will refuse the write.
 */
export function exportRoot(): string {
  const configured = process.env.EXPORT_ROOT?.trim();
  return canonicalBase(configured || path.join(appDir(), "exports"));
}

/**
 * Root for backup archives and the folder picker on the backup page.
 *
 * Defaults to `<app dir>/backups`; `BACKUP_ROOT` overrides it, with the same
 * `ReadWritePaths=` caveat as `EXPORT_ROOT`.
 */
export function backupRoot(): string {
  const configured = process.env.BACKUP_ROOT?.trim();
  return canonicalBase(configured || path.join(appDir(), "backups"));
}
