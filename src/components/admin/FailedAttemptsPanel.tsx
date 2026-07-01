"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Unlock } from "lucide-react";
import { useDateFormat } from "@/components/date-format/DateFormatProvider";

interface Attempt {
  id: number;
  identifier: string;
  ip: string;
  reason: string;
  keyName: string | null;
  createdAt: string;
}

interface LockedUser {
  username: string;
  lockedUntil: string;
  failedLoginAttempts: number;
}

interface BlockedIp {
  ip: string;
  resetAt: string;
}

const REASON_LABEL: Record<string, string> = {
  bad_password: "Wrong password",
  bad_mfa: "Wrong MFA code",
  unknown_user: "Unknown username",
  invalid_key: "Invalid key",
  disabled_key: "Disabled key",
  revoked_key: "Revoked key",
  expired_key: "Expired key",
};

/**
 * Shared "failed attempts" panel for the Users (kind="login") and API Keys
 * (kind="api") admin pages. Shows a log of recent rejected attempts plus the
 * currently-active blocks (locked accounts / throttled IPs) with unblock buttons.
 *
 * `reloadSignal` lets a parent force a refetch (e.g. after unlocking from its own
 * table); `onChanged` is called after this panel lifts a block so the parent can
 * refresh its own view.
 */
export default function FailedAttemptsPanel({
  kind,
  reloadSignal = 0,
  onChanged,
}: {
  kind: "login" | "api";
  reloadSignal?: number;
  onChanged?: () => void;
}) {
  const { formatDateTime } = useDateFormat();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [lockedUsers, setLockedUsers] = useState<LockedUser[]>([]);
  const [blockedIps, setBlockedIps] = useState<BlockedIp[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/admin/failed-attempts?kind=${kind}`);
    if (res.ok) {
      const data = await res.json();
      setAttempts(data.attempts ?? []);
      setLockedUsers(data.lockedUsers ?? []);
      setBlockedIps(data.blockedIps ?? []);
    }
    setLoading(false);
  }, [kind]);

  useEffect(() => {
    if (expanded) load();
  }, [expanded, reloadSignal, load]);

  const unblock = async (scope: "username" | "ip", value: string) => {
    const res = await fetch("/api/admin/failed-attempts/unblock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, value }),
    });
    if (res.ok) {
      await load();
      onChanged?.();
    }
  };

  const activeBlockCount = lockedUsers.length + blockedIps.length;

  return (
    <div className="mt-6 bg-white rounded-lg border border-gray-200 overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
      >
        <span className="flex items-center gap-2 font-semibold text-gray-700 text-sm">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {kind === "login" ? "Failed login attempts" : "Failed API attempts"}
          {activeBlockCount > 0 && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
              {activeBlockCount} active {activeBlockCount === 1 ? "block" : "blocks"}
            </span>
          )}
        </span>
        {expanded && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              load();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                load();
              }
            }}
            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-gray-100 pt-4">
          {/* Active blocks */}
          {lockedUsers.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                Locked accounts
              </h4>
              <div className="space-y-1">
                {lockedUsers.map((u) => (
                  <div
                    key={u.username}
                    className="flex items-center justify-between text-sm bg-red-50 border border-red-100 rounded px-3 py-1.5"
                  >
                    <span className="text-gray-700">
                      <span className="font-medium">{u.username}</span>
                      <span className="text-gray-500 text-xs ml-2">
                        locked until {formatDateTime(u.lockedUntil)} · {u.failedLoginAttempts} failures
                      </span>
                    </span>
                    <button
                      onClick={() => unblock("username", u.username)}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-red-700 hover:bg-red-100 rounded"
                      title="Unlock account"
                    >
                      <Unlock size={12} /> Unlock
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {blockedIps.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                Blocked IP addresses
              </h4>
              <div className="space-y-1">
                {blockedIps.map((b) => (
                  <div
                    key={b.ip}
                    className="flex items-center justify-between text-sm bg-amber-50 border border-amber-100 rounded px-3 py-1.5"
                  >
                    <span className="text-gray-700">
                      <span className="font-mono">{b.ip}</span>
                      <span className="text-gray-500 text-xs ml-2">
                        throttled until {formatDateTime(b.resetAt)}
                      </span>
                    </span>
                    <button
                      onClick={() => unblock("ip", b.ip)}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-amber-700 hover:bg-amber-100 rounded"
                      title="Unblock IP"
                    >
                      <Unlock size={12} /> Unblock IP
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Attempt log */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
              Recent attempts (last 30 days)
            </h4>
            {attempts.length === 0 ? (
              <p className="text-sm text-gray-400 py-3">No failed attempts recorded.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">Time</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">
                        {kind === "login" ? "Username tried" : "Key tried"}
                      </th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">IP</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">Reason</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map((a) => (
                      <tr key={a.id} className="border-b border-gray-100">
                        <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">
                          {formatDateTime(a.createdAt)}
                        </td>
                        <td className="px-3 py-2 text-gray-700 text-xs font-mono break-all">
                          {a.identifier || <span className="text-gray-300">—</span>}
                          {a.keyName && (
                            <span className="ml-2 font-sans text-gray-500">({a.keyName})</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-600 text-xs font-mono">{a.ip}</td>
                        <td className="px-3 py-2 text-xs">
                          <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                            {REASON_LABEL[a.reason] ?? a.reason}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => unblock("ip", a.ip)}
                            className="flex items-center gap-1 px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded"
                            title="Unblock this IP"
                          >
                            <Unlock size={12} /> Unblock IP
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
