// Central registry of OAuth metadata for the Scheduled Exports providers.
// Used by the credential wizard, callback handler, and health-monitoring code.

export type CloudProvider = "google-drive" | "box" | "onedrive";

export interface ProviderConfig {
  label: string;
  scopes: string[];
  authorizeUrl: string | ((tenantId: string) => string);
  tokenUrl: string | ((tenantId: string) => string);
  // Extra params appended to the authorize URL (e.g. "access_type=offline").
  extraAuthParams?: Record<string, string>;
  // Provider's developer-console URL (shown in the wizard).
  consoleUrl: string;
  // How to register the redirect URI in the provider's console.
  registrationHelp: string;
  // Days idle (since lastSuccessAt) at which we warn / mark expired.
  // null = no clock-based expiry; only auth failures flip status.
  warnDaysIdle: number | null;
  expiredDaysIdle: number | null;
  // OneDrive needs a tenant ID; others ignore it.
  needsTenantId: boolean;
  // Per-schedule destination key used in ScheduledExport.config.
  // Either folderId (Google/Box) or folderPath (OneDrive).
  folderField: "folderId" | "folderPath";
}

export const PROVIDER_CONFIG: Record<CloudProvider, ProviderConfig> = {
  "google-drive": {
    label: "Google Drive",
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    registrationHelp:
      "In Google Cloud Console, create an OAuth 2.0 Client ID of type 'Web application' and add the redirect URI shown above to 'Authorized redirect URIs'.",
    // Google refresh tokens don't expire on a clock; only revocation/auth-fail flips status.
    warnDaysIdle: null,
    expiredDaysIdle: null,
    needsTenantId: false,
    folderField: "folderId",
  },
  box: {
    label: "Box",
    scopes: ["root_readwrite"],
    authorizeUrl: "https://account.box.com/api/oauth2/authorize",
    tokenUrl: "https://api.box.com/oauth2/token",
    consoleUrl: "https://app.box.com/developers/console",
    registrationHelp:
      "In the Box Developer Console, create a Custom App with 'User Authentication (OAuth 2.0)'. Under 'Configuration', add the redirect URI shown above and enable the 'Write all files and folders' application scope.",
    // Box refresh tokens expire 60 days after issue.
    warnDaysIdle: 50,
    expiredDaysIdle: 60,
    needsTenantId: false,
    folderField: "folderId",
  },
  onedrive: {
    label: "OneDrive",
    scopes: ["Files.ReadWrite", "User.Read", "offline_access"],
    authorizeUrl: (tenantId) =>
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
    tokenUrl: (tenantId) =>
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    extraAuthParams: { prompt: "consent", response_mode: "query" },
    consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps",
    registrationHelp:
      "In Microsoft Entra (Azure AD) > App registrations, create a new Web app, add the redirect URI shown above, and grant delegated permissions 'Files.ReadWrite', 'offline_access', and 'User.Read'.",
    // MS refresh tokens last ~90 days idle.
    warnDaysIdle: 75,
    expiredDaysIdle: 90,
    needsTenantId: true,
    folderField: "folderPath",
  },
};

export function isCloudProvider(provider: string): provider is CloudProvider {
  return provider in PROVIDER_CONFIG;
}

interface BuildAuthUrlOptions {
  provider: CloudProvider;
  clientId: string;
  redirectUri: string;
  state: string;
  tenantId?: string;
}

export function buildAuthUrl(opts: BuildAuthUrlOptions): string {
  const cfg = PROVIDER_CONFIG[opts.provider];
  const tenantId = opts.tenantId || "common";
  const baseUrl =
    typeof cfg.authorizeUrl === "function" ? cfg.authorizeUrl(tenantId) : cfg.authorizeUrl;

  const url = new URL(baseUrl);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cfg.scopes.join(" "));
  url.searchParams.set("state", opts.state);
  if (cfg.extraAuthParams) {
    for (const [key, value] of Object.entries(cfg.extraAuthParams)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export interface TokenResponse {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number; // unix seconds
}

interface ExchangeCodeOptions {
  provider: CloudProvider;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenantId?: string;
}

export async function exchangeCode(opts: ExchangeCodeOptions): Promise<TokenResponse> {
  const cfg = PROVIDER_CONFIG[opts.provider];
  const tenantId = opts.tenantId || "common";
  const tokenUrl =
    typeof cfg.tokenUrl === "function" ? cfg.tokenUrl(tenantId) : cfg.tokenUrl;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = (await response.json()) as {
    refresh_token?: string;
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !data.refresh_token) {
    const message = data.error_description || data.error || `Token exchange failed (HTTP ${response.status})`;
    throw new Error(message);
  }

  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: data.expires_in
      ? Math.floor(Date.now() / 1000) + data.expires_in
      : undefined,
  };
}

export interface RefreshOptions {
  provider: CloudProvider;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tenantId?: string;
}

export interface RefreshResult {
  accessToken: string;
  // OAuth providers may rotate the refresh token (Box does this on every grant).
  // Caller must persist this back to ExportCredential.config when it differs.
  refreshToken: string;
  expiresAt?: number;
}

/**
 * Exchange a refresh token for a fresh access token. Handles all three
 * cloud providers via their standard OAuth 2.0 refresh-token grants.
 *
 * Throws an Error whose message contains "invalid_grant" / "invalid_token"
 * when the refresh token has expired or been revoked — callers can treat
 * that as a definitive "credential expired" signal.
 */
export async function refreshTokens(opts: RefreshOptions): Promise<RefreshResult> {
  const cfg = PROVIDER_CONFIG[opts.provider];
  const tenantId = opts.tenantId || "common";
  const tokenUrl =
    typeof cfg.tokenUrl === "function" ? cfg.tokenUrl(tenantId) : cfg.tokenUrl;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  // OneDrive requires the same scopes on refresh; Google/Box accept omitted scopes.
  if (opts.provider === "onedrive") {
    body.set("scope", cfg.scopes.join(" "));
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !data.access_token) {
    const message = data.error_description || data.error || `Token refresh failed (HTTP ${response.status})`;
    throw new Error(message);
  }

  return {
    accessToken: data.access_token,
    // Rotated refresh token if the provider sent one back; otherwise reuse the original.
    refreshToken: data.refresh_token ?? opts.refreshToken,
    expiresAt: data.expires_in
      ? Math.floor(Date.now() / 1000) + data.expires_in
      : undefined,
  };
}

/**
 * Returns true when the error from refreshTokens / API probes indicates
 * the credential has expired or been revoked (vs. a transient network/server error).
 */
export function isAuthError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    message.includes("invalid_grant") ||
    message.includes("invalid_token") ||
    message.includes("invalid_request") ||
    message.includes("unauthorized") ||
    message.includes("expired") ||
    message.includes("revoked")
  );
}
