"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import { fetchMe } from "@/lib/fetch-me";
import { SESSION_TERMINATED_HEADER } from "@/lib/auth-headers";

interface AuthUser {
  id: number;
  username: string;
  role: string;
  displayName: string;
}

interface SessionTiming {
  // Idle window (ms) baked into the current session token.
  idleMs: number;
  // Absolute (hard) logout deadline, epoch ms.
  sessionExpiresAt: number;
}

interface AuthContextType {
  user: AuthUser | null;
  isAdmin: boolean;
  loading: boolean;
  session: SessionTiming | null;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isAdmin: false,
  loading: true,
  session: null,
  logout: async () => {},
  refreshUser: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

const PUBLIC_PATHS = ["/login", "/setup"];

export default function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<SessionTiming | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const isPublicPath = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // `force` bypasses the shared in-flight request so an explicit refresh
  // (post-login / MFA / preference change) always re-reads.
  const fetchUser = useCallback(async (force = false) => {
    try {
      const data = await fetchMe(force);
      if (data) {
        setUser(data);
        if (typeof data.idleMs === "number" && typeof data.sessionExpiresAt === "number") {
          setSession({ idleMs: data.idleMs, sessionExpiresAt: data.sessionExpiresAt });
        } else {
          setSession(null);
        }
      } else {
        setUser(null);
        setSession(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isPublicPath) {
      fetchUser();
    } else {
      setLoading(false);
    }
  }, [isPublicPath, fetchUser]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setSession(null);
    router.push("/login");
  }, [router]);

  const refreshUser = useCallback(() => fetchUser(true), [fetchUser]);

  // Watch every response for the "this session is over" marker the auth guards
  // set when the signed-in account has been disabled, and sign out cleanly.
  //
  // Wrapping `window.fetch` is deliberate: there is no shared fetch helper in
  // this app — each page calls `fetch` directly — so this is the only way to
  // cover all three paths a disabled user can arrive by (a full page load's
  // /api/auth/me, a client-side navigation's own data fetch, and the idle
  // keep-alive ping) without touching every call site. Only headers are read,
  // so no body is consumed or cloned and streaming responses are unaffected.
  const loggingOutRef = useRef(false);
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await original(...args);
      if (response.headers.has(SESSION_TERMINATED_HEADER) && !loggingOutRef.current) {
        // Latch, so the logout POST's own response can't re-enter this.
        loggingOutRef.current = true;
        void logout().finally(() => {
          loggingOutRef.current = false;
        });
      }
      return response;
    };
    return () => {
      window.fetch = original;
    };
  }, [logout]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAdmin: user?.role === "Admin" || user?.role === "SuperAdmin",
        loading,
        session,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
