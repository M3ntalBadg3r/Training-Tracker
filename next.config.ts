import type { NextConfig } from "next";
import pkg from "./package.json" with { type: "json" };

const nextConfig: NextConfig = {
  env: {
    APP_VERSION: pkg.version,
    UPDATE_CHANNEL: process.env.UPDATE_CHANNEL || "stable",
  },
  async headers() {
    // Content-Security-Policy. Next.js App Router uses inline <script> tags
    // for streaming + hydrating React Server Components, so script-src must
    // allow 'unsafe-inline' until we wire up nonce-based CSP via proxy.ts.
    // Tailwind v4 + Recharts emit inline styles too, hence 'unsafe-inline'
    // for style-src. 'unsafe-eval' is only relaxed in development for HMR.
    const scriptSrc =
      process.env.NODE_ENV === "production"
        ? "'self' 'unsafe-inline'"
        : "'self' 'unsafe-eval' 'unsafe-inline'";
    const csp = [
      "default-src 'self'",
      `script-src ${scriptSrc}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
