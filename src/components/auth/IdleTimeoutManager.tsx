"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Modal from "@/components/ui/Modal";
import { useAuth } from "@/components/auth/AuthProvider";

/**
 * Enforces the inactivity (idle) session timeout on the client. The server is
 * the authoritative boundary (the session token's sliding idle expiry, plus an
 * absolute cap), but this manager:
 *   1. Fires a throttled keep-alive ping while the user is active so an
 *      active-but-not-navigating session doesn't expire under them.
 *   2. Shows a warning modal with a countdown shortly before the idle window
 *      elapses, then signs the user out.
 * Idle window (idleMs) and the absolute deadline come from /api/auth/me via the
 * auth context.
 */
export default function IdleTimeoutManager() {
  const { user, session, logout } = useAuth();
  const [warningOpen, setWarningOpen] = useState(false);
  const [remainingSec, setRemainingSec] = useState(0);

  // Initialised in the effect below (avoids calling Date.now() during render).
  const lastActivityRef = useRef(0);
  const lastPingRef = useRef(0);
  const warningOpenRef = useRef(false);
  const loggingOutRef = useRef(false);

  const idleMs = session?.idleMs ?? 0;
  const sessionExpiresAt = session?.sessionExpiresAt ?? 0;
  const enabled = !!user && !!session && idleMs > 0;

  const doLogout = useCallback(() => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    void logout();
  }, [logout]);

  const ping = useCallback(() => {
    lastPingRef.current = Date.now();
    fetch("/api/auth/ping", { method: "POST" }).catch(() => {});
  }, []);

  const stayAlive = useCallback(() => {
    lastActivityRef.current = Date.now();
    warningOpenRef.current = false;
    setWarningOpen(false);
    ping();
  }, [ping]);

  useEffect(() => {
    if (!enabled) return;

    lastActivityRef.current = Date.now();
    lastPingRef.current = 0;
    loggingOutRef.current = false;

    // How long before the idle deadline the warning appears, and how often an
    // active user pings the server — both scaled so very short (test) windows
    // still warn and stay alive, capped at sensible defaults for normal windows.
    const warningMs = Math.min(60_000, Math.max(10_000, Math.floor(idleMs / 3)));
    const pingInterval = Math.min(5 * 60_000, Math.max(15_000, Math.floor(idleMs / 3)));

    const onActivity = () => {
      // While the warning is up, ignore passive activity — the user must make
      // an explicit choice so the session isn't extended by an accidental move.
      if (warningOpenRef.current) return;
      const now = Date.now();
      lastActivityRef.current = now;
      if (now - lastPingRef.current > pingInterval) ping();
    };

    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    const tick = setInterval(() => {
      const now = Date.now();
      // Absolute cap wins outright.
      if (sessionExpiresAt && now >= sessionExpiresAt) {
        doLogout();
        return;
      }
      const idleFor = now - lastActivityRef.current;
      if (idleFor >= idleMs) {
        doLogout();
        return;
      }
      if (idleFor >= idleMs - warningMs) {
        if (!warningOpenRef.current) {
          warningOpenRef.current = true;
          setWarningOpen(true);
        }
        setRemainingSec(
          Math.max(0, Math.ceil((lastActivityRef.current + idleMs - now) / 1000))
        );
      } else if (warningOpenRef.current) {
        warningOpenRef.current = false;
        setWarningOpen(false);
      }
    }, 1000);

    return () => {
      clearInterval(tick);
      events.forEach((e) => window.removeEventListener(e, onActivity));
    };
  }, [enabled, idleMs, sessionExpiresAt, ping, doLogout]);

  if (!enabled || !warningOpen) return null;

  return (
    <Modal
      open
      onClose={stayAlive}
      title="Still there?"
      size="sm"
      actions={
        <>
          <button
            onClick={doLogout}
            className="px-4 py-2 rounded border border-gray-300 text-sm font-medium hover:bg-gray-50"
          >
            Sign out
          </button>
          <button
            onClick={stayAlive}
            className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            Stay signed in
          </button>
        </>
      }
    >
      <p className="text-sm text-gray-600">
        You&apos;ve been inactive. For your security you&apos;ll be signed out in{" "}
        <span className="font-semibold text-gray-900">{remainingSec}s</span>.
      </p>
    </Modal>
  );
}
