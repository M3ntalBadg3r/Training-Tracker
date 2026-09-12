import type { CSSProperties } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import AuthProvider from "@/components/auth/AuthProvider";
import ThemeProvider from "@/components/theme/ThemeProvider";
import AppShell from "@/components/layout/AppShell";
import CompanyScopeProvider from "@/components/company/CompanyScopeProvider";
import DateFormatProvider from "@/components/date-format/DateFormatProvider";
import BrandProvider from "@/components/brand/BrandProvider";
import { getBrandingSafe } from "@/lib/system-settings";

/**
 * Branding is configured at runtime, so the shell must be rendered per-request.
 * Without this every route is statically prerendered and `generateMetadata`
 * runs at build time — which would bake the app name and favicon into the HTML
 * and leave a rename invisible until the next deploy. The cost is negligible:
 * every page here is a client shell that fetches its own data anyway.
 *
 * **This line is also what keeps the Content-Security-Policy working, and that
 * is the more expensive half to get wrong.** Next only stamps its per-request
 * nonce onto the `<script>` tags of routes it renders per request; anything it
 * prerenders ships chunk tags with no nonce at all. Under `CSP_MODE=enforce`
 * (see `lib/csp.ts`) the browser then refuses every script on those pages and
 * the user gets a blank shell — served with **HTTP 200**, which is what makes it
 * so unpleasant: `deploy/perform-update.sh` health-checks for `200|302|307`, so
 * an unattended install would take that update and report itself healthy.
 *
 * This is the only layout in the app, so this one line is why `npm run build`
 * reports every route as dynamic and none as static. If you are here to remove
 * it — because branding moved, or caching became attractive — the policy has to
 * be dealt with in the same change, not discovered afterwards.
 */
export const dynamic = "force-dynamic";

// Note: a segment may export `metadata` or `generateMetadata`, never both.
export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrandingSafe();
  return {
    // An empty string (rather than omitting the key) is deliberate: Next falls
    // back to the nearest ancestor's title when `title` is undefined, so only an
    // explicit "" actually clears it. The browser then shows the URL instead.
    title: brand.showNameInTab ? brand.appName : "",
    description: "Student Certification & Training Tracker",
    icons: {
      icon: brand.faviconMimeType
        ? [
            {
              url: `/api/branding/favicon?v=${brand.updatedAtMs}`,
              type: brand.faviconMimeType,
            },
          ]
        : "/favicon.ico",
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const brand = await getBrandingSafe();

  // Set as an inline style rather than a <style> block: inline declarations
  // outrank every author stylesheet rule regardless of cascade layer or source
  // order, so the ramp in globals.css can't accidentally win. <html> is :root,
  // so the var resolves for both the light ramp and the .dark overrides.
  //
  // `data-branded` gates the derived ramp: without a brand colour the app keeps
  // Tailwind's stock blue verbatim rather than an approximation of it.
  const branded = brand.brandColor !== null;
  const brandStyle = branded
    ? ({ "--brand-base": brand.brandColor } as CSSProperties)
    : undefined;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      style={brandStyle}
      {...(branded ? { "data-branded": "" } : {})}
    >
      <body className="antialiased">
        <BrandProvider
          value={{
            appName: brand.appName,
            logoUrl: brand.logoMimeType
              ? `/api/branding/logo?v=${brand.updatedAtMs}`
              : null,
            loginShowName: brand.loginShowName,
            loginShowLogo: brand.loginShowLogo,
          }}
        >
          <ThemeProvider>
            <AuthProvider>
              <DateFormatProvider>
                <CompanyScopeProvider>
                  <AppShell>{children}</AppShell>
                </CompanyScopeProvider>
              </DateFormatProvider>
            </AuthProvider>
          </ThemeProvider>
        </BrandProvider>
      </body>
    </html>
  );
}
