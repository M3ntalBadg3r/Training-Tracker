/**
 * Core export execution logic shared between the "Run Now" and cron-based execute endpoints.
 */

import prisma from "@/lib/prisma";
import { fetchReportData, type ReportType } from "@/lib/report-queries";
import { generateExportBuffer, getFileExtension, getMimeType } from "@/lib/server-export";
import { deliverLocal, deliverEmail, deliverGoogleDrive, deliverBox, deliverOneDrive } from "@/lib/export-destinations";
import type { ScheduledExport } from "@prisma/client";

function buildFilename(schedule: ScheduledExport): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ext = getFileExtension(schedule.format);
  const safe = schedule.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${safe}-${ts}.${ext}`;
}

async function getCredential(provider: string): Promise<Record<string, unknown> | null> {
  const cred = await prisma.exportCredential.findUnique({ where: { provider } });
  return cred ? (cred.config as Record<string, unknown>) : null;
}

export async function runExport(schedule: ScheduledExport): Promise<{ status: string; error?: string }> {
  try {
    const reportResult = await fetchReportData(schedule.reportType as ReportType);
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
        const cred = await getCredential("google-drive");
        if (!cred) throw new Error("Google Drive credentials not configured");
        await deliverGoogleDrive(buffer, filename, mimeType, {
          clientId: String(cred.clientId),
          clientSecret: String(cred.clientSecret),
          refreshToken: String(cred.refreshToken),
          folderId: config.folderId ? String(config.folderId) : (cred.folderId ? String(cred.folderId) : undefined),
        });
        break;
      }

      case "box": {
        const cred = await getCredential("box");
        if (!cred) throw new Error("Box credentials not configured");
        await deliverBox(buffer, filename, {
          clientId: String(cred.clientId),
          clientSecret: String(cred.clientSecret),
          accessToken: String(cred.accessToken),
          folderId: config.folderId ? String(config.folderId) : (cred.folderId ? String(cred.folderId) : undefined),
        });
        break;
      }

      case "onedrive": {
        const cred = await getCredential("onedrive");
        if (!cred) throw new Error("OneDrive credentials not configured");
        await deliverOneDrive(buffer, filename, {
          clientId: String(cred.clientId),
          tenantId: String(cred.tenantId),
          clientSecret: String(cred.clientSecret),
          folderPath: config.folderPath ? String(config.folderPath) : undefined,
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

    return { status: "success" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await prisma.scheduledExport.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date(), lastStatus: "error", lastError: message },
    });
    return { status: "error", error: message };
  }
}
