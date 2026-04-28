"use client";

import { useEffect, useRef, useState } from "react";
import Modal from "@/components/ui/Modal";
import { Copy, Check, ExternalLink, Loader2, ShieldCheck, AlertTriangle } from "lucide-react";

export type WizardProvider = "google-drive" | "box" | "onedrive";

interface ProviderMeta {
  label: string;
  consoleUrl: string;
  consoleLabel: string;
  intro: string;
  registrationSteps: string[];
  scopes: string[];
  needsTenantId: boolean;
  folderField: "folderId" | "folderPath";
  folderLabel: string;
  folderPlaceholder: string;
}

const PROVIDER_META: Record<WizardProvider, ProviderMeta> = {
  "google-drive": {
    label: "Google Drive",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    consoleLabel: "Google Cloud Console — Credentials",
    intro:
      "Training Tracker will upload scheduled reports to Google Drive on your behalf. You'll register an OAuth app in Google Cloud Console and Training Tracker will capture a refresh token automatically.",
    registrationSteps: [
      "Open Google Cloud Console (link above) and create a project (or select an existing one).",
      "Enable the 'Google Drive API' from the API Library.",
      "Go to 'Credentials' → 'Create Credentials' → 'OAuth client ID'.",
      "Choose application type 'Web application'.",
      "Under 'Authorized redirect URIs', click 'ADD URI' and paste the redirect URI shown below.",
      "Click 'Create'. Copy the Client ID and Client Secret to step 3.",
    ],
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    needsTenantId: false,
    folderField: "folderId",
    folderLabel: "Default Folder ID (optional)",
    folderPlaceholder: "e.g. 1A2B3C... (the part after /folders/ in the Drive URL)",
  },
  box: {
    label: "Box",
    consoleUrl: "https://app.box.com/developers/console",
    consoleLabel: "Box Developer Console",
    intro:
      "Training Tracker will upload scheduled reports to Box on your behalf. You'll register a Custom App in the Box Developer Console with User Authentication (OAuth 2.0).",
    registrationSteps: [
      "Open the Box Developer Console (link above).",
      "Click 'Create New App' → 'Custom App'.",
      "Choose authentication method 'User Authentication (OAuth 2.0)'.",
      "On the Configuration tab, paste the redirect URI shown below into 'OAuth 2.0 Redirect URIs'.",
      "Under 'Application Scopes', enable 'Write all files and folders stored in Box'.",
      "Save changes. Copy the Client ID and Client Secret to step 3.",
    ],
    scopes: ["root_readwrite"],
    needsTenantId: false,
    folderField: "folderId",
    folderLabel: "Default Folder ID (optional)",
    folderPlaceholder: "0 (root) or a folder ID from the Box URL",
  },
  onedrive: {
    label: "OneDrive",
    consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps",
    consoleLabel: "Microsoft Entra — App registrations",
    intro:
      "Training Tracker will upload scheduled reports to your OneDrive on your behalf. You'll register a Web app in Microsoft Entra (Azure AD).",
    registrationSteps: [
      "Open Microsoft Entra (link above) → 'New registration'.",
      "Pick supported account types — 'Accounts in any organizational directory and personal Microsoft accounts' works for the broadest range.",
      "Under 'Redirect URI', choose platform 'Web' and paste the redirect URI shown below.",
      "After creation, go to 'Certificates & secrets' → 'New client secret'. Copy the secret VALUE (not the ID).",
      "Go to 'API permissions' → 'Add a permission' → 'Microsoft Graph' → 'Delegated permissions' → grant 'Files.ReadWrite', 'offline_access', and 'User.Read'.",
      "From the 'Overview' page copy the Application (client) ID. If you want to scope to a specific tenant, also copy the Directory (tenant) ID; otherwise leave it blank to use 'common'.",
    ],
    scopes: ["Files.ReadWrite", "offline_access", "User.Read"],
    needsTenantId: true,
    folderField: "folderPath",
    folderLabel: "Default Folder Path (optional)",
    folderPlaceholder: "e.g. Reports/Scheduled",
  },
};

type Step = "intro" | "register" | "connect" | "success" | "error";

interface Props {
  open: boolean;
  provider: WizardProvider;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ProviderCredentialWizard({ open, provider, onClose, onSuccess }: Props) {
  const meta = PROVIDER_META[provider];

  const [step, setStep] = useState<Step>("intro");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [folderValue, setFolderValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [redirectUri, setRedirectUri] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [connectedAs, setConnectedAs] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute the redirect URI client-side so it's visible on the registration step
  // (matches the same derivation the server does at runtime).
  useEffect(() => {
    if (!open) return;
    setRedirectUri(
      `${window.location.origin}/api/admin/scheduled-exports/credentials/oauth/${provider}/callback`,
    );
  }, [open, provider]);

  // Reset all state when the wizard is opened.
  useEffect(() => {
    if (!open) return;
    setStep("intro");
    setClientId("");
    setClientSecret("");
    setTenantId("");
    setFolderValue("");
    setErrorMessage(null);
    setAuthUrl(null);
    setConnectedAs(null);
    setSubmitting(false);
  }, [open]);

  // Listen for the OAuth callback popup's postMessage.
  useEffect(() => {
    if (!open) return;
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; provider?: string; status?: string; message?: string };
      if (data?.type !== "tt-oauth" || data.provider !== provider) return;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      try {
        popupRef.current?.close();
      } catch {
        // ignore
      }
      if (data.status === "ok") {
        runTestConnection();
      } else {
        setErrorMessage(data.message ?? "Connection failed.");
        setStep("error");
        setSubmitting(false);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider]);

  async function runTestConnection() {
    try {
      const res = await fetch("/api/admin/scheduled-exports/credentials/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      if (data.success) {
        setConnectedAs(data.info?.email ?? data.info?.user ?? null);
        setStep("success");
        onSuccess();
      } else {
        setErrorMessage(data.error ?? "Test Connection failed.");
        setStep("error");
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStep("error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConnect() {
    if (!clientId.trim() || !clientSecret.trim()) {
      setErrorMessage("Client ID and Client Secret are required.");
      return;
    }
    setErrorMessage(null);
    setSubmitting(true);
    try {
      const body: Record<string, string> = {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      };
      if (meta.needsTenantId && tenantId.trim()) body.tenantId = tenantId.trim();
      if (folderValue.trim()) {
        body[meta.folderField] = folderValue.trim();
      }

      const res = await fetch(
        `/api/admin/scheduled-exports/credentials/oauth/${provider}/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `Failed to start OAuth flow (HTTP ${res.status})`);
      }

      const { authUrl: url } = (await res.json()) as { authUrl: string };
      setAuthUrl(url);

      const popup = window.open(url, "tt-oauth", "width=600,height=720,noopener=no");
      popupRef.current = popup;

      // Fallback: if no postMessage arrives within 90s, surface the URL.
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (step !== "success" && step !== "error") {
          setErrorMessage(
            "Did not receive a response from the popup. The popup may have been blocked — open the link below manually.",
          );
        }
      }, 90_000);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  function copyRedirectUri() {
    navigator.clipboard.writeText(redirectUri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const actions = (
    <>
      <button
        onClick={onClose}
        disabled={submitting}
        className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300 disabled:opacity-50"
      >
        {step === "success" ? "Done" : "Cancel"}
      </button>
      {step === "intro" && (
        <button
          onClick={() => setStep("register")}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Continue
        </button>
      )}
      {step === "register" && (
        <button
          onClick={() => setStep("connect")}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          I&rsquo;ve registered the app
        </button>
      )}
      {step === "connect" && (
        <button
          onClick={handleConnect}
          disabled={submitting}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting && <Loader2 size={14} className="animate-spin" />}
          {submitting ? "Waiting for sign-in…" : `Connect with ${meta.label}`}
        </button>
      )}
      {step === "error" && (
        <button
          onClick={() => {
            setErrorMessage(null);
            setStep("connect");
          }}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Edit credentials
        </button>
      )}
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title={`Connect ${meta.label}`} actions={actions} size="2xl">
      {step === "intro" && (
        <div className="space-y-3 text-sm text-gray-700">
          <p>{meta.intro}</p>
          <p className="text-gray-600">
            Training Tracker stores only the OAuth refresh token returned by {meta.label}. Your password is never seen by the app.
          </p>
        </div>
      )}

      {step === "register" && (
        <div className="space-y-4 text-sm text-gray-700">
          <a
            href={meta.consoleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-blue-600 hover:underline"
          >
            <ExternalLink size={14} /> Open {meta.consoleLabel}
          </a>
          <ol className="list-decimal pl-6 space-y-2">
            {meta.registrationSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Redirect URI to register</label>
            <div className="flex items-stretch gap-2">
              <input
                type="text"
                readOnly
                value={redirectUri}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono bg-gray-50"
              />
              <button
                onClick={copyRedirectUri}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              This URI must match exactly what you register in the provider console (including the protocol).
              If your install is behind a reverse proxy, make sure <code>X-Forwarded-Proto</code> and <code>X-Forwarded-Host</code> are forwarded.
            </p>
          </div>

          <div className="text-xs text-gray-500">
            <span className="font-semibold">Scopes requested:</span> {meta.scopes.join(", ")}
          </div>
        </div>
      )}

      {step === "connect" && (
        <div className="space-y-4 text-sm text-gray-700">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Client ID</label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Client Secret</label>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
            />
          </div>
          {meta.needsTenantId && (
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                Tenant ID (optional — defaults to <code>common</code>)
              </label>
              <input
                type="text"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                placeholder="common"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">{meta.folderLabel}</label>
            <input
              type="text"
              value={folderValue}
              onChange={(e) => setFolderValue(e.target.value)}
              placeholder={meta.folderPlaceholder}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
            />
          </div>

          {errorMessage && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div className="flex-1">
                <p>{errorMessage}</p>
                {authUrl && (
                  <p className="mt-1">
                    <a href={authUrl} target="_blank" rel="noopener noreferrer" className="underline">
                      Open the consent page in a new tab
                    </a>
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {step === "success" && (
        <div className="space-y-3 text-sm text-gray-700">
          <div className="flex items-center gap-2 text-green-700">
            <ShieldCheck size={20} />
            <span className="font-semibold">Connected successfully.</span>
          </div>
          {connectedAs && (
            <p>
              {meta.label} is connected as <span className="font-mono">{connectedAs}</span>.
            </p>
          )}
          <p className="text-gray-600">
            You can now schedule exports to {meta.label}. Training Tracker will check this credential daily and warn you if it&rsquo;s about to expire.
          </p>
        </div>
      )}

      {step === "error" && (
        <div className="space-y-3 text-sm text-gray-700">
          <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-800">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Could not connect to {meta.label}.</p>
              <p className="mt-1">{errorMessage}</p>
            </div>
          </div>
          <p className="text-gray-600">
            Check that the Client ID, Client Secret, and registered redirect URI all match what&rsquo;s in the {meta.label} developer console.
          </p>
        </div>
      )}
    </Modal>
  );
}
