/**
 * Delivery logic for scheduled export destinations.
 * Handles: local filesystem, email (SMTP), Google Drive, Box, OneDrive.
 *
 * All cloud providers use OAuth 2.0 refresh-token grants. Box rotates its
 * refresh token on every grant, so callers must persist the rotated token
 * via persistRefreshToken() after every successful delivery.
 */

import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { refreshTokens } from "@/lib/oauth-providers";
import { persistRefreshToken } from "@/lib/credential-health";
import { exportRoot, resolveWithin } from "@/lib/safe-path";

// ─── Local filesystem ────────────────────────────────────────────────────────────

export interface LocalConfig {
  path: string;
  retentionCount?: number;
}

/**
 * Thrown when a schedule's stored destination is not usable. The message is
 * written by us and is safe to show an admin, unlike a raw delivery error —
 * `run-export` uses this type to tell the two apart.
 */
export class ExportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportConfigError";
  }
}

/**
 * Coerce a stored `config` blob into a usable local destination.
 *
 * `config` is untyped JSON written by any company Admin, so nothing in it can be
 * trusted. The directory must resolve inside `exportRoot()`; a relative value is
 * treated as a sub-folder of it, and omitting it altogether means the root.
 */
export function normaliseLocalExportConfig(
  config: Record<string, unknown>,
): { path: string; retentionCount: number } | { error: string } {
  const root = exportRoot();
  const requested = config.path == null || config.path === "" ? root : config.path;
  const resolved = resolveWithin(root, requested, { allowBase: true });

  if (!resolved) {
    return {
      error:
        `Output path must be inside the exports folder (${root}). ` +
        `Choose a folder there, or set EXPORT_ROOT in .env to the folder you want to export to.`,
    };
  }

  return { path: resolved, retentionCount: normaliseRetention(config.retentionCount) };
}

/**
 * Retention must be a whole number of files to keep. A fractional value used to
 * reach `Array.prototype.slice`, which truncates toward zero — so `0.5` passed
 * the `> 0` guard and then sliced from index 0, deleting every file in the
 * directory including the export just written.
 */
function normaliseRetention(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

export async function deliverLocal(buffer: Buffer, filename: string, config: LocalConfig): Promise<void> {
  // Re-assert containment here rather than trusting the caller: this function
  // performs the mkdir, the write and the delete sweep, so the check belongs
  // next to the syscalls it protects.
  const dir = resolveWithin(exportRoot(), config.path, { allowBase: true });
  if (!dir) {
    throw new ExportConfigError("Output path is outside the exports folder.");
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, filename), buffer);

  const retention = normaliseRetention(config.retentionCount);
  if (retention > 0) {
    const ext = path.extname(filename);
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(ext))
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(retention)) {
      fs.unlinkSync(path.join(dir, file.name));
    }
  }
}

// ─── Email ───────────────────────────────────────────────────────────────────────

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  to: string;
  /** Per-credential opt-out from TLS certificate verification. Default: verify. */
  allowInsecureTls?: boolean;
}

export async function deliverEmail(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  subject: string,
  config: EmailConfig
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    // Verify the server's certificate unless this credential opted out. The
    // probe in `credential-health.ts` must stay in step: a delivery that trusts
    // more than the connection test did would pass its check and then hand the
    // password to whatever answered.
    tls: { rejectUnauthorized: config.allowInsecureTls !== true },
    // Same reasoning as the probe: nodemailer's defaults are about two minutes,
    // so a filtered host would stall every scheduled send for that long.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  await transporter.sendMail({
    from: config.from,
    to: config.to,
    subject,
    text: `Please find the scheduled report attached: ${filename}`,
    attachments: [{ filename, content: buffer, contentType: mimeType }],
  });
}

// ─── Google Drive ────────────────────────────────────────────────────────────────

export interface GoogleDriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId?: string;
}

export async function deliverGoogleDrive(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  config: GoogleDriveConfig
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { google } = require("googleapis");
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
  auth.setCredentials({ refresh_token: config.refreshToken });

  const drive = google.drive({ version: "v3", auth });
  const metadata: Record<string, unknown> = { name: filename };
  if (config.folderId) metadata.parents = [config.folderId];

  await drive.files.create({
    requestBody: metadata,
    media: { mimeType, body: Readable.from(buffer) },
    fields: "id",
  });
}

// ─── Box ─────────────────────────────────────────────────────────────────────────

export interface BoxConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId?: string;
}

export async function deliverBox(
  buffer: Buffer,
  filename: string,
  config: BoxConfig
): Promise<void> {
  const refreshed = await refreshTokens({
    provider: "box",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken,
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BoxSDK = require("box-node-sdk");
  const sdk = new BoxSDK({ clientID: config.clientId, clientSecret: config.clientSecret });
  const client = sdk.getBasicClient(refreshed.accessToken);
  const folderId = config.folderId ?? "0";
  await client.files.uploadFile(folderId, filename, buffer);

  // Box rotates refresh tokens on every grant — persist the new one or the
  // next run will fail. Best-effort: swallow persist errors so the upload
  // (which already succeeded) isn't reported as a failure.
  try {
    await persistRefreshToken("box", refreshed.refreshToken);
  } catch (err) {
    console.error("Failed to persist rotated Box refresh token:", err);
  }
}

// ─── OneDrive ────────────────────────────────────────────────────────────────────

export interface OneDriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tenantId?: string;
  folderPath?: string;
}

export async function deliverOneDrive(
  buffer: Buffer,
  filename: string,
  config: OneDriveConfig
): Promise<void> {
  const refreshed = await refreshTokens({
    provider: "onedrive",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken,
    tenantId: config.tenantId,
  });

  const uploadPath = config.folderPath
    ? `${config.folderPath.replace(/^\/|\/$/g, "")}/${filename}`
    : filename;

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURI(uploadPath)}:/content`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${refreshed.accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(buffer),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`OneDrive upload failed (HTTP ${response.status}): ${errorBody}`);
  }

  if (refreshed.refreshToken !== config.refreshToken) {
    try {
      await persistRefreshToken("onedrive", refreshed.refreshToken);
    } catch (err) {
      console.error("Failed to persist rotated OneDrive refresh token:", err);
    }
  }
}
