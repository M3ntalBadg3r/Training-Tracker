import type { NextConfig } from "next";
import pkg from "./package.json" with { type: "json" };
import { buildCsp, resolveCspMode } from "./src/lib/csp";

const nextConfig: NextConfig = {
  // Stop `next dev` appending its own block to CLAUDE.md on every start.
  //
  // Next 16.3 added a feature that writes a "nextjs-agent-rules" section into
  // CLAUDE.md / AGENTS.md each time the dev server boots (the guard on their
  // side is `agentRules !== false`, so this is the documented opt-out). It
  // arrived here as a side effect of the 16.2.1 -> 16.3.4 dependency upgrade,
  // not as a choice.
  //
  // Two reasons to turn it off. CLAUDE.md is a hand-maintained document, and a
  // file that silently re-modifies itself shows up as an unexplained dirty file
  // in every `git status` — which invites someone to "clean it up" with
  // `git checkout CLAUDE.md`, discarding whatever real edits were in flight.
  // And the text it inserts asks to be committed, which is not a decision a
  // build tool gets to make about this project's documentation.
  agentRules: false,
  env: {
    APP_VERSION: pkg.version,
    UPDATE_CHANNEL: process.env.UPDATE_CHANNEL || "stable",
  },
  async headers() {
    // Content-Security-Policy — for the few paths `src/proxy.ts` does NOT see.
    //
    // The policy moved to the proxy, because the strict variant carries a
    // per-request nonce and this function runs once, at build time. What is
    // left here covers exactly the paths the proxy's matcher excludes
    // (`/_next/static`, `/_next/image`, `/favicon.ico`) — static assets, which
    // never need a nonce.
    //
    // The two sources cover DISJOINT sets of paths, deliberately. The CSP key
    // used to live on the catch-all `/(.*)` entry below; leaving it there would
    // now put a second `Content-Security-Policy` header on every proxied
    // response, and browsers enforce the intersection of two policies rather
    // than the later one. The other five security headers stay on `/(.*)`,
    // where a duplicate is not a hazard and the single entry is clearer.
    //
    // One asymmetry worth knowing: `CSP_MODE` is read here at BUILD time and in
    // the proxy at REQUEST time, so changing the mode on a running install
    // changes the policy on pages and API routes but not on these static-asset
    // paths until the next build. That is harmless — a policy on a JS or icon
    // response governs only the (non-existent) document it would be if opened
    // directly — but it would be confusing to hit and not know.
    const staticCsp = buildCsp({
      nonce: null,
      strict: resolveCspMode(process.env.CSP_MODE) === "enforce",
      isDev: process.env.NODE_ENV !== "production",
    });
    const cspHeader = [
      { key: "Content-Security-Policy", value: staticCsp },
    ];

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
        ],
      },
      // Kept in step with the `matcher` in `src/proxy.ts`. If a path is added
      // to that exclusion list it must be added here too, or it will be the one
      // path in the app with no policy at all.
      { source: "/_next/static/:path*", headers: cspHeader },
      { source: "/_next/image", headers: cspHeader },
      { source: "/favicon.ico", headers: cspHeader },
    ];
  },
};

export default nextConfig;
