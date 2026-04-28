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

// ─── Local filesystem ────────────────────────────────────────────────────────────

export interface LocalConfig {
  path: string;
  retentionCount?: number;
}

export async function deliverLocal(buffer: Buffer, filename: string, config: LocalConfig): Promise<void> {
  const dir = config.path;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, filename), buffer);

  const retention = config.retentionCount ?? 0;
  if (retention > 0) {
    const ext = path.extname(filename);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
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
    tls: { rejectUnauthorized: false },
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
