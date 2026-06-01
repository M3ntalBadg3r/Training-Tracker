"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Download, X } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";

interface UpdateCheck {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}

const STORAGE_KEY = "tt.updateBannerDismissed";

export default function UpdateAvailableBanner() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "SuperAdmin";

  const [data, setData] = useState<UpdateCheck | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() =>
    typeof window === "undefined" ? null : window.sessionStorage.getItem(STORAGE_KEY),
  );

  useEffect(() => {
    if (!isSuperAdmin) return;

    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/admin/updates/check", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as UpdateCheck;
        if (!cancelled) setData(json);
      } catch {
        // Silently ignore — banner just won't render.
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin]);

  if (!isSuperAdmin) return null;
  if (!data?.updateAvailable || !data.latestVersion) return null;
  if (dismissedVersion === data.latestVersion) return null;

  const handleDismiss = () => {
    if (typeof window !== "undefined" && data.latestVersion) {
      window.sessionStorage.setItem(STORAGE_KEY, data.latestVersion);
    }
    setDismissedVersion(data.latestVersion);
  };

  return (
    <div className="mb-6 border rounded-lg px-4 py-3 bg-blue-50 border-blue-300 text-blue-900">
      <div className="flex items-start gap-3">
        <Download size={20} className="shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="font-semibold">Update available — v{data.latestVersion}</p>
          <p className="mt-1 text-sm">
            You are running v{data.currentVersion}. A newer release is ready to install.{" "}
            <Link href="/admin/updates" className="underline font-medium">
              View update
            </Link>
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 p-1 hover:bg-blue-100 rounded transition-colors"
          aria-label="Dismiss update notification"
          title="Dismiss"
        >
          <X size={18} className="text-blue-700" />
        </button>
      </div>
    </div>
  );
}
