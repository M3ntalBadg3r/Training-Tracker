"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Save, CheckCircle, Upload, Trash2, RotateCcw, ShieldCheck } from "lucide-react";
import HexColorPickerField from "@/components/ui/HexColorPickerField";
import Modal from "@/components/ui/Modal";

const MAX_APP_NAME_LENGTH = 60;

interface BrandingState {
  appName: string;
  brandColor: string | null;
  hasLogo: boolean;
  hasFavicon: boolean;
  loginShowName: boolean;
  loginShowLogo: boolean;
  showNameInTab: boolean;
  updatedAtMs: number;
}

const EMPTY: BrandingState = {
  appName: "Training Tracker",
  brandColor: null,
  hasLogo: false,
  hasFavicon: false,
  loginShowName: true,
  loginShowLogo: true,
  showNameInTab: true,
  updatedAtMs: 0,
};

/**
 * Relative luminance per WCAG 2.x, used to warn when a brand colour won't carry
 * white button text.
 */
/** Apply (or clear) the brand colour on the document element for live preview. */
function applyPreview(color: string | null): void {
  const root = document.documentElement;
  if (color) {
    root.style.setProperty("--brand-base", color);
    root.setAttribute("data-branded", "");
  } else {
    root.style.removeProperty("--brand-base");
    root.removeAttribute("data-branded");
  }
}

function contrastWithWhite(hex: string): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05);
}

export default function BrandingSection() {
  const [state, setState] = useState<BrandingState>(EMPTY);
  const [original, setOriginal] = useState<BrandingState>(EMPTY);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [faviconFile, setFaviconFile] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [removeFavicon, setRemoveFavicon] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  const faviconInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/branding");
        if (!res.ok) {
          setError("Failed to load branding settings");
          return;
        }
        const data: BrandingState = await res.json();
        setState(data);
        setOriginal(data);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /**
   * Live preview. The blue ramp is declared on :root, so var() substitution
   * happens there — setting --brand-base on a preview element would have no
   * effect on the palette inside it. Write to the document element instead, and
   * restore the saved value when the section unmounts. `data-branded` has to be
   * toggled alongside the variable, since the derived ramp is gated on it.
   */
  useEffect(() => {
    applyPreview(state.brandColor);
  }, [state.brandColor]);

  useEffect(() => {
    const savedColor = original.brandColor;
    return () => applyPreview(savedColor);
  }, [original.brandColor]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const form = new FormData();
      form.append("appName", state.appName);
      form.append("brandColor", state.brandColor ?? "");
      form.append("loginShowName", String(state.loginShowName));
      form.append("loginShowLogo", String(state.loginShowLogo));
      form.append("showNameInTab", String(state.showNameInTab));
      if (logoFile) form.append("logo", logoFile);
      if (faviconFile) form.append("favicon", faviconFile);
      if (removeLogo) form.append("removeLogo", "true");
      if (removeFavicon) form.append("removeFavicon", "true");

      const res = await fetch("/api/admin/branding", { method: "PUT", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to save");
        return;
      }
      setSaved(true);
      // The tab title and favicon come from the server layout's metadata, which
      // a client-side refresh doesn't re-run — reload so every branded surface
      // updates at once. This is a one-off admin action, so the cost is fine.
      window.location.reload();
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setConfirmReset(false);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/branding", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to reset");
        return;
      }
      window.location.reload();
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading branding settings...</div>
      </div>
    );
  }

  const dirty =
    state.appName !== original.appName ||
    state.brandColor !== original.brandColor ||
    state.loginShowName !== original.loginShowName ||
    state.loginShowLogo !== original.loginShowLogo ||
    state.showNameInTab !== original.showNameInTab ||
    logoFile !== null ||
    faviconFile !== null ||
    removeLogo ||
    removeFavicon;

  const lowContrast =
    state.brandColor !== null && contrastWithWhite(state.brandColor) < 4.5;

  const showLogoPreview = !removeLogo && (logoFile !== null || original.hasLogo);
  const logoPreviewSrc = logoFile
    ? URL.createObjectURL(logoFile)
    : `/api/branding/logo?v=${original.updatedAtMs}`;
  const showFaviconPreview =
    !removeFavicon && (faviconFile !== null || original.hasFavicon);
  const faviconPreviewSrc = faviconFile
    ? URL.createObjectURL(faviconFile)
    : `/api/branding/favicon?v=${original.updatedAtMs}`;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-2">Branding</h2>
      <p className="text-sm text-gray-500 mb-6">
        Replace the product name, logo, favicon and accent colour with your own.
        These apply to everyone on this instance and take effect immediately &mdash;
        no reinstall or restart is needed.
      </p>

      {/* Name */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Application name
        </label>
        <input
          type="text"
          value={state.appName}
          maxLength={MAX_APP_NAME_LENGTH}
          onChange={(e) => setState({ ...state, appName: e.target.value })}
          className="w-full max-w-sm px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
        />
        <p className="text-xs text-gray-500 mt-1">
          Shown in the sidebar, the browser tab, the login page and your users&apos;
          authenticator apps. Up to {MAX_APP_NAME_LENGTH} characters.
        </p>
        <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
          <input
            type="checkbox"
            checked={state.showNameInTab}
            onChange={(e) => setState({ ...state, showNameInTab: e.target.checked })}
          />
          Show the name in the browser tab
        </label>
        <p className="text-xs text-gray-500 mt-1">
          Turn this off to leave the tab untitled &mdash; the browser then shows the
          address instead of a name.
        </p>
      </div>

      {/* Colour */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Brand colour
        </label>
        <HexColorPickerField
          value={state.brandColor}
          onChange={(brandColor) => setState({ ...state, brandColor })}
          emptyLabel="Default blue"
        />
        <p className="text-xs text-gray-500 mt-1">
          Re-tints every accent in the app &mdash; buttons, links, focus rings and
          the active navigation highlight. Charts and PDF exports keep their own
          palette. Clear the field to return to the default blue.
        </p>
        {lowContrast && (
          <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
            This colour is light enough that white button text may be hard to
            read. A darker shade is recommended.
          </div>
        )}
      </div>

      {/* Logo */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">Logo</label>
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 border border-gray-200 rounded-lg flex items-center justify-center overflow-hidden bg-gray-50">
            {showLogoPreview ? (
              <Image
                src={logoPreviewSrc}
                alt="Logo preview"
                width={40}
                height={40}
                unoptimized
                className="max-h-10 w-auto object-contain"
              />
            ) : (
              <ShieldCheck size={24} className="text-blue-600" />
            )}
          </div>
          <input
            ref={logoInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/x-icon"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              if (file) {
                setLogoFile(file);
                setRemoveLogo(false);
              }
            }}
          />
          <button
            type="button"
            onClick={() => logoInput.current?.click()}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Upload size={14} /> Choose file
          </button>
          {showLogoPreview && (
            <button
              type="button"
              onClick={() => {
                setLogoFile(null);
                setRemoveLogo(true);
                if (logoInput.current) logoInput.current.value = "";
              }}
              className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg"
            >
              <Trash2 size={14} /> Remove
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Shown on the login, setup and MFA pages. PNG, JPEG, WebP or ICO, up to
          512 KB. Falls back to the built-in shield when no logo is set.
        </p>
      </div>

      {/* Favicon */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">Favicon</label>
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 border border-gray-200 rounded-lg flex items-center justify-center overflow-hidden bg-gray-50">
            {showFaviconPreview ? (
              <Image
                src={faviconPreviewSrc}
                alt="Favicon preview"
                width={24}
                height={24}
                unoptimized
                className="h-6 w-6 object-contain"
              />
            ) : (
              <span className="text-xs text-gray-400">Default</span>
            )}
          </div>
          <input
            ref={faviconInput}
            type="file"
            accept="image/png,image/x-icon,.ico"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              if (file) {
                setFaviconFile(file);
                setRemoveFavicon(false);
              }
            }}
          />
          <button
            type="button"
            onClick={() => faviconInput.current?.click()}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Upload size={14} /> Choose file
          </button>
          {showFaviconPreview && (
            <button
              type="button"
              onClick={() => {
                setFaviconFile(null);
                setRemoveFavicon(true);
                if (faviconInput.current) faviconInput.current.value = "";
              }}
              className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg"
            >
              <Trash2 size={14} /> Remove
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-1">
          The browser tab icon. PNG or ICO, up to 128 KB. A square image of at
          least 32&times;32 works best.
        </p>
      </div>

      {/* Login page */}
      <div className="mb-6 border-t border-gray-200 pt-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Login page</h3>
        <p className="text-xs text-gray-500 mb-3">
          Hide either half of the login header &mdash; useful when your logo already
          contains the name, or when you want a plain sign-in form. These affect
          the login page only; the sidebar always shows the name.
        </p>
        <label className="flex items-center gap-2 text-sm text-gray-700 mb-2">
          <input
            type="checkbox"
            checked={state.loginShowLogo}
            onChange={(e) => setState({ ...state, loginShowLogo: e.target.checked })}
          />
          Show the logo on the login page
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={state.loginShowName}
            onChange={(e) => setState({ ...state, loginShowName: e.target.checked })}
          />
          Show the name on the login page
        </label>
      </div>

      {error && (
        <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
          {error}
        </div>
      )}
      {saved && (
        <div className="mt-4 flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-2">
          <CheckCircle size={14} /> Saved.
        </div>
      )}

      <div className="mt-6 flex gap-3">
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Save size={14} />
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          onClick={() => setConfirmReset(true)}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          <RotateCcw size={14} /> Reset to defaults
        </button>
      </div>

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset branding?"
        actions={
          <>
            <button
              onClick={() => setConfirmReset(false)}
              className="px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleReset}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              Reset branding
            </button>
          </>
        }
      >
        <p className="text-sm text-gray-600">
          This clears the custom name, colour, logo and favicon, returning the app
          to its default appearance. It doesn&apos;t affect any of your data.
        </p>
      </Modal>
    </div>
  );
}
