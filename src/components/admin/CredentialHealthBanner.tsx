"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, AlertCircle } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";

interface HealthEntry {
  provider: string;
  label: string;
  configured: boolean;
  status: "ok" | "expiring" | "expired" | "failed" | "unknown";
  daysIdle: number | null;
  daysUntilExpiry: number | null;
  message: string;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;

export default function CredentialHealthBanner() {
  const { isAdmin } = useAuth();
  const [entries, setEntries] = useState<HealthEntry[]>([]);

  useEffect(() => {
    if (!isAdmin) return;

    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/admin/scheduled-exports/credentials/health", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as HealthEntry[];
        if (!cancelled) setEntries(data);
      } catch {
        // Silently ignore — banner just won't render this poll.
      }
    }

    load();

    // Refresh when another tab finishes a wizard.
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string };
      if (data?.type === "tt-oauth") load();
    }
    window.addEventListener("message", onMessage);

    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("message", onMessage);
    };
  }, [isAdmin]);

  if (!isAdmin) return null;

  const problems = entries.filter(
    (e) => e.configured && (e.status === "expired" || e.status === "failed" || e.status === "expiring"),
  );
  if (problems.length === 0) return null;

  const hasHardFailure = problems.some((p) => p.status === "expired" || p.status === "failed");
  const colour = hasHardFailure
    ? "bg-red-50 border-red-300 text-red-900"
    : "bg-amber-50 border-amber-300 text-amber-900";
  const Icon = hasHardFailure ? AlertCircle : AlertTriangle;
  const heading = hasHardFailure
    ? "Scheduled-export credentials need attention"
    : "Scheduled-export credentials expiring soon";

  return (
    <div className={`mb-6 border rounded-lg px-4 py-3 ${colour}`}>
      <div className="flex items-start gap-3">
        <Icon size={20} className="shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="font-semibold">{heading}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {problems.map((p) => (
              <li key={p.provider}>
                <span className="font-medium">{p.label}:</span> {p.message}{" "}
                <Link
                  href={`/admin/scheduled-exports#credentials-${p.provider}`}
                  className="underline font-medium"
                >
                  Reconnect
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
