import prisma from "@/lib/prisma";
import { sealConfig, openConfig } from "@/lib/crypto";
import {
  PROVIDER_CONFIG,
  isCloudProvider,
  refreshTokens,
  isAuthError,
  type CloudProvider,
} from "@/lib/oauth-providers";

/**
 * Read the (decrypted) config object for a provider. Centralised so callers
 * can't accidentally read the raw column.
 */
export async function readCredentialConfig(
  provider: string,
): Promise<Record<string, unknown> | null> {
  const cred = await prisma.exportCredential.findUnique({ where: { provider } });
  if (!cred) return null;
  return openConfig(cred.config);
}

/** Seal + persist a credential config. Upserts the row. */
export async function writeCredentialConfig(
  provider: string,
  config: Record<string, unknown>,
): Promise<void> {
  const sealed = sealConfig(config);
  await prisma.exportCredential.upsert({
    where: { provider },
    create: { provider, config: sealed as object },
    update: { config: sealed as object },
  });
}

const SMTP_PROVIDER = "email";
const ALL_TRACKED_PROVIDERS = [...Object.keys(PROVIDER_CONFIG), SMTP_PROVIDER] as const;

export type RawCheckStatus = "ok" | "expired" | "failed";
export type UiHealthStatus = "ok" | "expiring" | "expired" | "failed" | "unknown";

export interface ProbeResult {
  status: RawCheckStatus;
  error?: string;
  info?: { user?: string; email?: string };
}

export interface HealthSummaryEntry {
  provider: string;
  label: string;
  configured: boolean;
  status: UiHealthStatus;
  daysIdle: number | null;
  daysUntilExpiry: number | null;
  message: string;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastCheckError: string | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_CONFIG).map(([key, cfg]) => [key, cfg.label]),
  ),
  email: "Email (SMTP)",
};

/**
 * Cheap auth probe for a single provider. Returns the new credential health
 * snapshot but does NOT persist anything to the DB on its own — callers
 * (e.g. recordProbeResult) should write the result back.
 *
 * For OAuth cloud providers, this will also persist any rotated refresh
 * token (Box rotates on every grant) so subsequent probes / exports use
 * the latest token.
 */
export async function probeCredential(provider: string): Promise<ProbeResult> {
  if (provider === SMTP_PROVIDER) {
    return probeEmail();
  }
  if (!isCloudProvider(provider)) {
    return { status: "failed", error: `Unknown provider: ${provider}` };
  }

  const cred = await prisma.exportCredential.findUnique({ where: { provider } });
  if (!cred) {
    return { status: "failed", error: "Credentials not configured" };
  }

  const config = openConfig(cred.config);
  const refreshToken = typeof config.refreshToken === "string" ? config.refreshToken : "";
  const clientId = typeof config.clientId === "string" ? config.clientId : "";
  const clientSecret = typeof config.clientSecret === "string" ? config.clientSecret : "";

  if (!refreshToken || !clientId || !clientSecret) {
    return { status: "expired", error: "Missing refresh token — please reconnect" };
  }

  try {
    const refreshed = await refreshTokens({
      provider,
      clientId,
      clientSecret,
      refreshToken,
      tenantId: typeof config.tenantId === "string" ? config.tenantId : undefined,
    });

    // Persist a rotated refresh token so subsequent probes/exports stay valid.
    if (refreshed.refreshToken !== refreshToken) {
      await persistRefreshToken(provider, refreshed.refreshToken);
    }

    const info = await fetchProviderUserInfo(provider, refreshed.accessToken, config);
    return { status: "ok", info };
  } catch (err) {
    const status: RawCheckStatus = isAuthError(err) ? "expired" : "failed";
    const message = err instanceof Error ? err.message : String(err);
    return { status, error: message };
  }
}

async function probeEmail(): Promise<ProbeResult> {
  const cred = await prisma.exportCredential.findUnique({ where: { provider: "email" } });
  if (!cred) return { status: "failed", error: "Credentials not configured" };
  const config = openConfig(cred.config);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: String(config.host ?? ""),
      port: Number(config.port ?? 587),
      secure: Boolean(config.secure),
      auth: {
        user: String(config.user ?? ""),
        pass: String(config.password ?? ""),
      },
      tls: { rejectUnauthorized: false },
    });
    await transporter.verify();
    return { status: "ok", info: { email: String(config.from ?? config.user ?? "") } };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchProviderUserInfo(
  provider: CloudProvider,
  accessToken: string,
  config: Record<string, unknown>,
): Promise<{ user?: string; email?: string } | undefined> {
  try {
    if (provider === "google-drive") {
      const res = await fetch(
        "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) return undefined;
      const data = (await res.json()) as { user?: { displayName?: string; emailAddress?: string } };
      return { user: data.user?.displayName, email: data.user?.emailAddress };
    }
    if (provider === "box") {
      const res = await fetch("https://api.box.com/2.0/users/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { name?: string; login?: string };
      return { user: data.name, email: data.login };
    }
    if (provider === "onedrive") {
      const res = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { displayName?: string; mail?: string; userPrincipalName?: string };
      return { user: data.displayName, email: data.mail ?? data.userPrincipalName };
    }
  } catch {
    return undefined;
  }
  // Mark config as referenced for ESLint; future per-provider tweaks may need it.
  void config;
  return undefined;
}

/**
 * Persist a rotated refresh token back to ExportCredential.config.
 * Used by probeCredential and by export-destinations after every successful Box upload.
 */
export async function persistRefreshToken(provider: string, refreshToken: string): Promise<void> {
  const cred = await prisma.exportCredential.findUnique({ where: { provider } });
  if (!cred) return;
  const config = openConfig(cred.config);
  if (config.refreshToken === refreshToken) return;
  const sealed = sealConfig({ ...config, refreshToken });
  await prisma.exportCredential.update({
    where: { provider },
    data: { config: sealed as object },
  });
}

/**
 * Combine probeCredential with persistence of the result on ExportCredential
 * (lastCheckedAt/lastCheckStatus/lastCheckError, plus lastSuccessAt on OK).
 */
export async function checkCredential(provider: string): Promise<ProbeResult> {
  const result = await probeCredential(provider);
  const now = new Date();
  await prisma.exportCredential.update({
    where: { provider },
    data: {
      lastCheckedAt: now,
      lastCheckStatus: result.status,
      lastCheckError: result.error ?? null,
      ...(result.status === "ok" ? { lastSuccessAt: now } : {}),
    },
  }).catch(() => {
    // Provider row may have been deleted between probe and update; ignore.
  });
  return result;
}

/**
 * Mark a credential as successful (without re-running the probe).
 * Called after a successful scheduled export delivery.
 */
export async function markCredentialSuccess(provider: string): Promise<void> {
  const now = new Date();
  await prisma.exportCredential.update({
    where: { provider },
    data: {
      lastSuccessAt: now,
      lastCheckedAt: now,
      lastCheckStatus: "ok",
      lastCheckError: null,
    },
  }).catch(() => {
    // Row may have been removed; ignore.
  });
}

/**
 * Mark a credential as failed (called by run-export when delivery fails).
 */
export async function markCredentialFailure(provider: string, error: string): Promise<void> {
  const status: RawCheckStatus = isAuthError(error) ? "expired" : "failed";
  await prisma.exportCredential.update({
    where: { provider },
    data: {
      lastCheckedAt: new Date(),
      lastCheckStatus: status,
      lastCheckError: error,
    },
  }).catch(() => {
    // Row may have been removed; ignore.
  });
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function diffDays(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / MS_PER_DAY);
}

function summariseRow(
  provider: string,
  row: { lastCheckStatus: string | null; lastCheckError: string | null; lastCheckedAt: Date | null; lastSuccessAt: Date | null } | null,
): HealthSummaryEntry {
  const label = PROVIDER_LABELS[provider] ?? provider;

  if (!row) {
    return {
      provider,
      label,
      configured: false,
      status: "unknown",
      daysIdle: null,
      daysUntilExpiry: null,
      message: "Not configured",
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastCheckError: null,
    };
  }

  const cfg = isCloudProvider(provider) ? PROVIDER_CONFIG[provider] : null;
  const now = new Date();
  const daysIdle = row.lastSuccessAt ? diffDays(now, row.lastSuccessAt) : null;
  const daysUntilExpiry =
    cfg?.expiredDaysIdle != null && daysIdle != null
      ? Math.max(0, cfg.expiredDaysIdle - daysIdle)
      : null;

  // No probe has ever run AND no successful delivery → "unknown" (don't scare fresh installs).
  if (row.lastCheckStatus == null && row.lastSuccessAt == null) {
    return {
      provider,
      label,
      configured: true,
      status: "unknown",
      daysIdle,
      daysUntilExpiry,
      message: "Not yet checked",
      lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
      lastSuccessAt: null,
      lastCheckError: row.lastCheckError,
    };
  }

  // Hard failures from the most recent probe always win.
  if (row.lastCheckStatus === "expired") {
    return {
      provider,
      label,
      configured: true,
      status: "expired",
      daysIdle,
      daysUntilExpiry,
      message: row.lastCheckError ?? `${label} credential has expired — please reconnect.`,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastCheckError: row.lastCheckError,
    };
  }
  if (row.lastCheckStatus === "failed") {
    return {
      provider,
      label,
      configured: true,
      status: "failed",
      daysIdle,
      daysUntilExpiry,
      message: row.lastCheckError ?? `${label} connection failed.`,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastCheckError: row.lastCheckError,
    };
  }

  // OK — but flag if we're approaching the expiry-by-idle threshold.
  if (
    cfg?.warnDaysIdle != null &&
    daysIdle != null &&
    daysIdle >= cfg.warnDaysIdle
  ) {
    const days = daysUntilExpiry ?? 0;
    return {
      provider,
      label,
      configured: true,
      status: "expiring",
      daysIdle,
      daysUntilExpiry,
      message:
        days > 0
          ? `${label} credential expires in ${days} day${days === 1 ? "" : "s"}. Reconnect to avoid interruption.`
          : `${label} credential is about to expire. Reconnect now.`,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastCheckError: null,
    };
  }

  return {
    provider,
    label,
    configured: true,
    status: "ok",
    daysIdle,
    daysUntilExpiry,
    message: "Healthy",
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastCheckError: null,
  };
}

export async function getCredentialHealthSummary(): Promise<HealthSummaryEntry[]> {
  const rows = await prisma.exportCredential.findMany({
    select: {
      provider: true,
      lastCheckedAt: true,
      lastCheckStatus: true,
      lastCheckError: true,
      lastSuccessAt: true,
    },
  });
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  return ALL_TRACKED_PROVIDERS.map((provider) => summariseRow(provider, byProvider.get(provider) ?? null));
}
