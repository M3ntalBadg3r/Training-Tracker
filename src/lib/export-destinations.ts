/**
 * Delivery logic for scheduled export destinations.
 * Handles: local filesystem, email (SMTP), Google Drive, Box, OneDrive.
 */

import fs from "fs";
import path from "path";
import { Readable } from "stream";

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

  // Retention: prune oldest files with same base name pattern if retentionCount set
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
  accessToken: string;
  folderId?: string;
}

export async function deliverBox(
  buffer: Buffer,
  filename: string,
  config: BoxConfig
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BoxSDK = require("box-node-sdk");
  const sdk = new BoxSDK({ clientID: config.clientId, clientSecret: config.clientSecret });
  const client = sdk.getBasicClient(config.accessToken);
  const folderId = config.folderId ?? "0";
  await client.files.uploadFile(folderId, filename, buffer);
}

// ─── OneDrive ────────────────────────────────────────────────────────────────────

export interface OneDriveConfig {
  clientId: string;
  tenantId: string;
  clientSecret: string;
  folderPath?: string;
}

export async function deliverOneDrive(
  buffer: Buffer,
  filename: string,
  config: OneDriveConfig
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const msal = require("@azure/msal-node");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("@microsoft/microsoft-graph-client");

  const msalApp = new msal.ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientSecret: config.clientSecret,
    },
  });

  const tokenResponse = await msalApp.acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });

  const graphClient = Client.init({
    authProvider: (done: (err: null, token: string) => void) => {
      done(null, tokenResponse.accessToken);
    },
  });

  const uploadPath = config.folderPath
    ? `${config.folderPath.replace(/\/$/, "")}/${filename}`
    : filename;

  await graphClient
    .api(`/me/drive/root:/${uploadPath}:/content`)
    .put(buffer);
}
