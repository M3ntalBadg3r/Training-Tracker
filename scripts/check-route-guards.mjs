#!/usr/bin/env node
/**
 * Route guard check — the standing enforcement of Round 1 item 3.
 *
 * Every exported HTTP handler under `src/app/api/**` must either call one of the
 * recognised auth guards, or appear in PUBLIC_HANDLERS below with a reason.
 *
 * ## Why this exists
 *
 * "Add requireAuth() to every handler" was completed once, in April, and then
 * decayed: it is a per-route obligation that every new handler inherits, but
 * nothing carried it forward, so handlers written afterwards were never held to
 * it. A reflected-XSS finding and an auth bypass both traced back to a handler
 * that simply never got a guard, and in the XSS case the route was *implicitly*
 * public — nobody had decided that, it just was.
 *
 * PUBLIC_HANDLERS turns that silent omission into a line of code someone has to
 * write and a reviewer can see.
 *
 * ## Why the check is per handler, not per file
 *
 * `GET /api/training-data/[title]` was unguarded while its PUT/PATCH/DELETE
 * siblings in the same file all called requireSuperAdmin. A per-file check would
 * have passed that file and missed a live auth hole, so each exported handler is
 * inspected on its own.
 *
 * Usage:
 *   node scripts/check-route-guards.mjs              # check; non-zero on a gap
 *   node scripts/check-route-guards.mjs --inventory  # print the full table
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const API_ROOT = join(process.cwd(), "src", "app", "api");

/** Calls that count as authenticating a request. */
const GUARD_PATTERN =
  /\b(requireAuth|requireSuperAdmin|requireFullSession|authorizePublicRequest|requireApiKey|authorizeCronRequest|ensurePublicApiEnabled)\s*\(/;

/**
 * Handlers that are deliberately reachable without a session, with the reason.
 *
 * Keep this list SHORT and justify every entry. Adding one is a security
 * decision: it says an unauthenticated caller may reach this code. Anything
 * here must be safe to expose to the internet with no credentials at all.
 */
const PUBLIC_HANDLERS = {
  "auth/login/route.ts": {
    POST: "Issues the session. Rate-limited per IP and per account.",
  },
  "auth/logout/route.ts": {
    POST: "Clears the cookie. Deliberately unguarded so a session that has already been terminated can still log itself out.",
  },
  "auth/setup/route.ts": {
    GET: "Reports only whether the instance still needs first-run setup. No data, no session.",
    POST: "First-run wizard. Self-guards by refusing once any user exists.",
  },
  "branding/logo/route.ts": {
    GET: "White-label logo, rendered by the login page before anyone has signed in.",
  },
  "branding/favicon/route.ts": {
    GET: "White-label favicon, rendered by the login page before anyone has signed in.",
  },
};

/**
 * Handlers that authenticate with `getAuthFromRequest` instead of a guard.
 *
 * These exist because `requireAuth` is too strict for them — they must stay
 * reachable while a session is pending MFA enrolment, or they re-issue the
 * cookie themselves. The cost is that the checks `requireAuth` performs are not
 * inherited and have to be written out by hand, which is exactly what went
 * wrong: `mfa/setup` and `mfa/verify` were missing both of them, so a suspended
 * account could still complete enrolment and be handed a fresh session token.
 *
 * So this list is not an exemption. Every handler on it must call
 * `getAuthFromRequest` *and* every check below.
 *
 * The requirement list grows whenever `requireAuth` gains a check — and it has
 * to grow in the same change, or this assertion quietly covers only part of the
 * rule while still reporting green, which is worse than asserting nothing.
 * `isUserDeleted` was added for exactly that reason.
 */
const SELF_GUARDED_HANDLERS = {
  "auth/change-password/route.ts": { POST: "Re-issues the caller's cookie with a bumped session epoch." },
  "auth/me/route.ts": { GET: "Must stay reachable during pending-MFA enrolment." },
  "auth/mfa/setup/route.ts": { POST: "Enrolment: reached while the session is pending MFA." },
  "auth/mfa/verify/route.ts": { POST: "Enrolment: reached while the session is pending MFA; issues a new token." },
  "auth/ping/route.ts": { POST: "Keep-alive: must stay reachable during pending-MFA enrolment." },
};

/** What a self-guarded handler must spell out, since it inherits nothing. */
const SELF_GUARD_REQUIREMENTS = [
  { name: "getAuthFromRequest", re: /\bgetAuthFromRequest\s*\(/ },
  { name: "isUserDisabled", re: /\bisUserDisabled\s*\(/ },
  { name: "isUserDeleted", re: /\bisUserDeleted\s*\(/ },
  { name: "isSessionEpochStale", re: /\bisSessionEpochStale\s*\(/ },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/**
 * Extract a function's balanced {...} body.
 *
 * `openParen` is the index of the "(" starting the parameter list. Skipping past
 * the matching ")" first is load-bearing: these handlers are routinely declared
 * as `function GET(request, { params }: {...})`, so the first "{" after the
 * function name belongs to a destructured parameter, not the body — reading that
 * instead reports every such handler as unguarded.
 */
function extractBody(src, openParen) {
  let depth = 0;
  let i = openParen;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  const start = src.indexOf("{", i);
  if (start === -1) return "";
  depth = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return src.slice(start);
}

/**
 * Bodies of non-handler functions declared in the same file, so a handler that
 * delegates its auth to a local helper still counts as guarded.
 */
function localHelperBodies(src) {
  const bodies = new Map();
  const re = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)) continue;
    bodies.set(name, extractBody(src, m.index + m[0].length - 1));
  }
  return bodies;
}

function isGuarded(body, helpers) {
  if (GUARD_PATTERN.test(body)) return true;
  // One level of indirection: a local helper that itself guards.
  for (const [name, helperBody] of helpers) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(body) && GUARD_PATTERN.test(helperBody)) {
      return true;
    }
  }
  return false;
}

const files = walk(API_ROOT).sort();
const rows = [];
const violations = [];
const staleAllowlist = [];

for (const file of files) {
  const rel = relative(API_ROOT, file).split(sep).join("/");
  const src = readFileSync(file, "utf8");
  const helpers = localHelperBodies(src);
  const allowed = PUBLIC_HANDLERS[rel] ?? {};
  const selfGuarded = SELF_GUARDED_HANDLERS[rel] ?? {};
  const seen = new Set();

  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const method = m[1];
    seen.add(method);
    const body = extractBody(src, m.index + m[0].length - 1);
    const guarded = isGuarded(body, helpers);
    const exempt = Object.hasOwn(allowed, method);
    const isSelfGuarded = Object.hasOwn(selfGuarded, method);

    if (isSelfGuarded) {
      // Not an exemption: verify it really does perform the checks by hand.
      const missing = SELF_GUARD_REQUIREMENTS.filter((r) => !r.re.test(body)).map(
        (r) => r.name
      );
      rows.push({
        rel,
        method,
        state: missing.length ? "INCOMPLETE" : "self-guarded",
      });
      if (missing.length) {
        violations.push(
          `${rel}  ${method} — self-guarded but missing: ${missing.join(", ")}`
        );
      }
      continue;
    }

    rows.push({ rel, method, state: guarded ? "guarded" : exempt ? "public" : "UNGUARDED" });

    if (!guarded && !exempt) violations.push(`${rel}  ${method}`);
    if (guarded && exempt) {
      staleAllowlist.push(`${rel}  ${method} — guarded, so the allow-list entry is stale`);
    }
  }

  for (const method of Object.keys(selfGuarded)) {
    if (!seen.has(method)) {
      staleAllowlist.push(
        `${rel}  ${method} — listed as self-guarded but no such handler exists`
      );
    }
  }

  for (const method of Object.keys(allowed)) {
    if (!seen.has(method)) {
      staleAllowlist.push(`${rel}  ${method} — allow-listed but no such handler exists`);
    }
  }
}

/**
 * Cron endpoints must be listed in BOTH places or they do not work.
 *
 * A handler accepting cron auth is only reachable if `proxy.ts` also lets the
 * request through — the proxy runs first and has no idea what the handler
 * accepts. `credentials/check` had the handler half and not the proxy half, so
 * the daily credential health check was rejected before it ever arrived and
 * silently never ran. The two lists are compared here so that cannot recur.
 */
const cronMismatches = [];
{
  const handlerRoutes = new Set(
    files
      .filter((f) => /\bauthorizeCronRequest\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => {
        const rel = relative(API_ROOT, f).split(sep).join("/");
        return "/api/" + rel.replace(/\/route\.ts$/, "");
      })
  );
  const proxySrc = readFileSync(join(process.cwd(), "src", "proxy.ts"), "utf8");
  const proxyRoutes = new Set(
    [...proxySrc.matchAll(/pathname === "(\/api\/[^"]+)"/g)].map((m) => m[1])
  );
  for (const r of handlerRoutes) {
    if (!proxyRoutes.has(r)) {
      cronMismatches.push(`${r} — handler accepts cron auth, but proxy.ts does not let it through`);
    }
  }
  for (const r of proxyRoutes) {
    if (!handlerRoutes.has(r)) {
      cronMismatches.push(`${r} — proxy.ts lets cron through, but the handler does not call authorizeCronRequest`);
    }
  }
}

if (process.argv.includes("--inventory")) {
  const width = Math.max(...rows.map((r) => r.rel.length));
  for (const r of rows) {
    console.log(`${r.rel.padEnd(width)}  ${r.method.padEnd(6)}  ${r.state}`);
  }
  const counts = rows.reduce((a, r) => ((a[r.state] = (a[r.state] ?? 0) + 1), a), {});
  console.log(
    `\n${files.length} route files, ${rows.length} handlers — ` +
      Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")
  );
}

let failed = false;

if (violations.length) {
  failed = true;
  console.error(
    `\n${violations.length} handler(s) under src/app/api/** have no auth guard:\n`
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nAdd one of requireAuth / requireSuperAdmin / requireFullSession /\n" +
      "authorizePublicRequest / requireApiKey / authorizeCronRequest, or — if the\n" +
      "handler is genuinely meant to be reachable with no session — add it to\n" +
      "PUBLIC_HANDLERS in scripts/check-route-guards.mjs with the reason.\n"
  );
}

if (cronMismatches.length) {
  failed = true;
  console.error(`\n${cronMismatches.length} cron endpoint mismatch(es):\n`);
  for (const c of cronMismatches) console.error(`  ${c}`);
  console.error(
    "\nA cron endpoint must appear in proxy.ts's isCronRequest list AND call\n" +
      "authorizeCronRequest in its handler. With only one, the job fails with a\n" +
      "401 that looks like a credentials problem.\n"
  );
}

if (staleAllowlist.length) {
  failed = true;
  console.error(`\n${staleAllowlist.length} stale PUBLIC_HANDLERS entr(y/ies):\n`);
  for (const s of staleAllowlist) console.error(`  ${s}`);
  console.error("\nRemove them so the list keeps meaning what it says.\n");
}

if (failed) process.exit(1);

if (!process.argv.includes("--inventory")) {
  const publicCount = rows.filter((r) => r.state === "public").length;
  console.log(
    `Route guards OK — ${rows.length} handlers across ${files.length} routes ` +
      `(${publicCount} intentionally public).`
  );
}
