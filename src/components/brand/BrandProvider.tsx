"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface Branding {
  appName: string;
  /** URL of the uploaded logo, or null to fall back to the built-in mark. */
  logoUrl: string | null;
  /** Login-page header switches — either half can be suppressed. */
  loginShowName: boolean;
  loginShowLogo: boolean;
}

export const BRANDING_FALLBACK: Branding = {
  appName: "Training Tracker",
  logoUrl: null,
  loginShowName: true,
  loginShowLogo: true,
};

const BrandContext = createContext<Branding>(BRANDING_FALLBACK);

/**
 * Branding is read once by the (server) root layout and handed down as props —
 * deliberately not fetched. A client-side fetch would put a request in front of
 * every page load and flash the default product name before the real one
 * arrived, which is exactly what a white-labelled install must not do.
 */
export default function BrandProvider({
  value,
  children,
}: {
  value: Branding;
  children: ReactNode;
}) {
  // Destructured so the memo depends on the individual fields rather than the
  // object identity — the server layout hands down a fresh object literal on
  // every render, which would otherwise defeat the memo entirely.
  const { appName, logoUrl, loginShowName, loginShowLogo } = value;
  const memo = useMemo(
    () => ({ appName, logoUrl, loginShowName, loginShowLogo }),
    [appName, logoUrl, loginShowName, loginShowLogo]
  );
  return <BrandContext.Provider value={memo}>{children}</BrandContext.Provider>;
}

export function useBrand(): Branding {
  return useContext(BrandContext);
}
