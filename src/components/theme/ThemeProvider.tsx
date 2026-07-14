"use client";

import { createContext, useContext, useEffect, useCallback, useSyncExternalStore, ReactNode } from "react";

type Theme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: "light",
  toggleTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

// The theme lives in localStorage; we read it via useSyncExternalStore so there
// is no setState-in-effect on mount and no hydration mismatch (the server
// snapshot is always "light").
const THEME_EVENT = "tt-theme-change";

function getThemeSnapshot(): Theme {
  return typeof window !== "undefined" && localStorage.getItem("theme") === "dark" ? "dark" : "light";
}

function getThemeServerSnapshot(): Theme {
  return "light";
}

function subscribeTheme(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(THEME_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(THEME_EVENT, callback);
  };
}

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot);

  // Reflect the current theme onto the document (DOM side-effect only — no state).
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next: Theme = getThemeSnapshot() === "light" ? "dark" : "light";
    localStorage.setItem("theme", next);
    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
