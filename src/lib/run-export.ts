/**
 * Core export execution logic shared between the "Run Now" and cron-based execute endpoints.
 */

import prisma from "@/lib/prisma";
import { fetchReportData, type ReportType } from "@/lib/report-queries";
import { generateExportBuffer, getFileExtension, getMimeType } from "@/lib/server-export";
import { deliverLocal, deliverEmail, deliverGoogleDrive, deliverBox, deliverOneDrive } from "@/lib/export-destinations";
import {
  markCredentialSuccess,
  markCredentialFailure,
  readCredentialConfig,
} from "@/lib/credential-health";
import type { ScheduledExport } from "@prisma/client";

function buildFilename(schedule: ScheduledExport): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ext = getFileExtension(schedule.format);
  const safe = schedule.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${safe}-${ts}.${ext}`;
}

async function getCredential(provider: string): Promise<Record<string, unknown> | null> {
  return readCredentialConfig(provider);
}

function requireRefreshToken(provider: string, cred: Record<string, unknown>): string {
  const token = typeof cred.refreshToken === "string" ? cred.refreshToken : "";
  if (!token) {
    throw new Error(`${provider} credential is missing a refresh token — please reconnect from Admin > Scheduled Exports.`);
  }
  return token;
}

export async function runExport(schedule: ScheduledExport): Promise<{ status: string; error?: string }> {
  let credentialProvider: string | null = null;
  try {
    const reportResult = await fetchReportData(schedule.reportType as ReportType, schedule.companyId);
    const buffer = generateExportBuffer(reportResult.data, reportResult.columns, schedule.format, reportResult.title);
    const filename = buildFilename(schedule);
    const mimeType = getMimeType(schedule.format);
    const config = schedule.config as Record<string, unknown>;

    switch (schedule.destination) {
      case "local": {
        await deliverLocal(buffer, filename, {
          path: String(config.path ?? "/opt/training-tracker/exports"),
          retentionCount: config.retentionCount ? Number(config.retentionCount) : 0,
        });
        break;
      }

      case "email": {
        credentialProvider = "email";
        const cred = await getCredential("email");
        if (!cred) throw new Error("Email credentials not configured");
        await deliverEmail(buffer, filename, mimeType, `Scheduled Report: ${schedule.name}`, {
          host: String(cred.host),
          port: Number(cred.port ?? 587),
          secure: Boolean(cred.secure),
          user: String(cred.user),
          password: String(cred.password),
          from: String(cred.from),
          to: String(config.to ?? cred.from),
        });
        break;
      }

      case "google-drive": {
        credentialProvider = "google-drive";
        const cred = await getCredential("google-drive");
        if (!cred) throw new Error("Google Drive credentials not configured");
        await deliverGoogleDrive(buffer, filename, mimeType, {
          clientId: String(cred.clientId),
          clientSecret: String(cred.clientSecret),
          refreshToken: requireRefreshToken("google-drive", cred),
          folderId: config.folderId ? String(config.folderId) : (cred.folderId ? String(cred.folderId) : undefined),
        });
        break;
      }

      case "box": {
        credentialProvider = "box";
        const cred = await getCredential("box");
        if (!cred) throw new Error("Box credentials not configured");
        await deliverBox(buffer, filename, {
          clientId: String(cred.clientId),
          clientSecret: String(cred.clientSecret),
          refreshToken: requireRefreshToken("box", cred),
          folderId: config.folderId ? String(config.folderId) : (cred.folderId ? String(cred.folderId) : undefined),
        });
        break;
      }

      case "onedrive": {
        credentialProvider = "onedrive";
        const cred = await getCredential("onedrive");
        if (!cred) throw new Error("OneDrive credentials not configured");
        await deliverOneDrive(buffer, filename, {
          clientId: String(cred.clientId),
          clientSecret: String(cred.clientSecret),
          refreshToken: requireRefreshToken("onedrive", cred),
          tenantId: cred.tenantId ? String(cred.tenantId) : undefined,
          folderPath: config.folderPath ? String(config.folderPath) : (cred.folderPath ? String(cred.folderPath) : undefined),
        });
        break;
      }

      default:
        throw new Error(`Unknown destination: ${schedule.destination}`);
    }

    await prisma.scheduledExport.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date(), lastStatus: "success", lastError: null },
    });

    if (credentialProvider) {
      await markCredentialSuccess(credentialProvider);
    }

    return { status: "success" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await prisma.scheduledExport.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date(), lastStatus: "error", lastError: message },
    });

    if (credentialProvider) {
      await markCredentialFailure(credentialProvider, message);
    }

    return { status: "error", error: message };
  }
}
