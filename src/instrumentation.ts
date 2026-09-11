/**
 * Boot-time environment validation.
 *
 * Next.js calls `register()` once when a server instance starts. Every
 * environment variable this app depends on was previously read lazily, at the
 * moment some request happened to need it — which meant a misconfigured
 * install looked healthy until the exact wrong thing was attempted, and in
 * three cases never looked unhealthy at all:
 *
 *  - `JWT_SECRET` missing: the app starts, the first-run setup wizard happily
 *    creates a SuperAdmin account, and then every login returns a generic
 *    500 from inside the handler.
 *  - `ENCRYPTION_KEY` missing: silent. Secrets at rest (TOTP shared secrets,
 *    SMTP passwords, OAuth refresh tokens) are simply written to Postgres in
 *    plaintext, with nothing logged anywhere.
 *  - `CRON_SECRET` missing: silent. Every scheduled backup/export/credential
 *    check is rejected with the same answer as a forged signature, so the
 *    failure reads like somebody else's problem.
 *
 * Two of these are fatal here rather than warnings. Without `JWT_SECRET` or
 * `DATABASE_URL` the app cannot serve a single authenticated request, so
 * failing at boot with a named reason beats 500s from inside a handler that
 * name nothing. Everything else warns, because the app is genuinely usable
 * without it.
 *
 * **What throwing from `register()` actually does** — measured against a real
 * `next start` and the kernel's socket table, not assumed, because the answer
 * is neither "nothing" nor the restart loop you would expect:
 *
 *  - Next catches the rejection. The process **stays alive and keeps the
 *    listening socket bound** for its whole life (`/proc/net/tcp` shows the
 *    port in `TCP_LISTEN`), so `Restart=on-failure` never fires and a
 *    misconfigured install does not restart-loop.
 *  - **Dynamic routes** 500, re-logging the reason each time. **Static assets
 *    still return 200** — `/favicon.ico` and `/_next/static/**` are served
 *    normally. So it is not true that "every request" fails.
 *  - Consequently **every supervisor signal reads healthy**: the unit is
 *    `active (running)`, the port accepts connections, and a health check on a
 *    static path or a bare TCP probe passes. Only a dynamic route reveals the
 *    outage. (The unattended update path is fine: `deploy/perform-update.sh`
 *    health-checks a dynamic path for `200|302|307`, gets 500, and rolls back.)
 *  - The boot report is printed *after* Next's own "Ready" line.
 *
 * The honest argument **against** the throw is log amplification: one stack
 * trace per dynamic request, on an internet-facing box, driven by anyone who
 * can reach the port — where `process.exit(1)` would log once per restart
 * attempt. It is kept anyway, because `process.exit(1)` with the shipped unit
 * (`Restart=on-failure`, `RestartSec=10`, no `StartLimitBurst=`) restarts every
 * ten seconds forever, and tuning that lives in `deploy/` — a file this change
 * does not own. Between "down, loud, and misreported as healthy by a TCP
 * probe" and "down, loud, and flapping", the first is recoverable by an
 * operator reading one line of the journal. Revisit if the unit ever grows
 * start-limit settings.
 *
 * **Nothing is imported at module scope**, and that is not fastidiousness.
 * This module is compiled for the edge runtime as well as for Node, and a
 * static `import … from "node:net"` here made Turbopack print
 * "Ecmascript file had an error" on every successful build — which
 * `deploy/perform-update.sh` copies into `.update-log`, the file an operator
 * reads when an update goes wrong. A false alarm on every healthy run is how a
 * log stops being read, which is the same argument this module makes about
 * startup noise. So the one dependency it needs is pulled in **dynamically,
 * inside the `NEXT_RUNTIME` guard**, where the edge build never reaches it.
 * That also keeps the promise that matters: no Prisma, no app graph, no
 * database needed in order to report that the database is unconfigured.
 */

import type { TrustedProxies } from "@/lib/client-ip";

/** Where an operator is told to put things. Matches `deploy/install.sh`. */
const ENV_FILE_HINT =
  "Set it in the app's .env file (/opt/training-tracker/.env on a standard install; the systemd unit " +
  "reads that file via EnvironmentFile=) and restart the service.";

type Level = "fatal" | "warn" | "note";

interface Finding {
  level: Level;
  variable: string;
  message: string;
}

/** JWT_SECRET's minimum length, restated from `lib/auth.ts:getJwtSecret`. */
const MIN_JWT_SECRET_LENGTH = 32;

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;

function collectFindings(env: NodeJS.ProcessEnv, trusted: TrustedProxies): Finding[] {
  const findings: Finding[] = [];
  const add = (level: Level, variable: string, message: string) =>
    findings.push({ level, variable, message });

  // --- Fatal: the app cannot serve an authenticated request without these ---

  // The length rule is restated rather than imported: `lib/auth.ts` pulls in
  // bcryptjs, otpauth and Prisma, and this module must stay dependency-free.
  // `lib/auth.ts`, `lib/oauth-state.ts` and `proxy.ts` each already carry their
  // own copy, so this is a fourth reader of one rule — consolidating them is a
  // separate change across files this one does not own. If the rule moves,
  // move it here too.
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    add("fatal", "JWT_SECRET", `not set — no session token can be signed or verified. ${ENV_FILE_HINT}`);
  } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    add(
      "fatal",
      "JWT_SECRET",
      `is ${jwtSecret.length} characters; at least ${MIN_JWT_SECRET_LENGTH} are required. ` +
        `Generate one with: openssl rand -hex 32. ${ENV_FILE_HINT}`
    );
  }

  if (!env.DATABASE_URL) {
    add(
      "fatal",
      "DATABASE_URL",
      `not set — there is no database to read or write. ${ENV_FILE_HINT}`
    );
  } else if (!/^postgres(ql)?:\/\//i.test(env.DATABASE_URL)) {
    // Not fatal: only the scheme is being judged here, and a value this module
    // cannot parse may still be one the driver accepts.
    add(
      "warn",
      "DATABASE_URL",
      "does not start with postgresql:// — this app only supports PostgreSQL, so connections will likely fail."
    );
  }

  // --- Warn: usable without, but something is silently not working ---

  const encryptionKey = env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    add(
      "warn",
      "ENCRYPTION_KEY",
      "not set — secrets at rest (TOTP shared secrets, SMTP passwords, OAuth refresh tokens) will be stored " +
        "in the database UNENCRYPTED, and backup archives cannot be encrypted. Generate with: openssl rand -hex 32, " +
        "then have a SuperAdmin POST /api/admin/security/encrypt-secrets once to seal any rows already stored."
    );
  } else if (!HEX_32_BYTES.test(encryptionKey)) {
    add(
      "warn",
      "ENCRYPTION_KEY",
      "is not a 64-character hex string, so it is ignored exactly as if it were unset: secrets will be stored " +
        "UNENCRYPTED. Generate a valid one with: openssl rand -hex 32."
    );
  }

  if (!env.CRON_SECRET) {
    add(
      "warn",
      "CRON_SECRET",
      "not set — automatic backups, scheduled exports and the daily credential health check will be rejected, " +
        "with the same 401 a forged signature gets. Generate with: openssl rand -hex 32 (the value must match the " +
        "one the deploy/auto-*.sh cron scripts read from the same .env)."
    );
  }

  // --- Notes: silent defaults that are usually right but worth stating ---
  // Production only, so `next dev` stays completely quiet. A startup check
  // that talks on every healthy boot is a startup check nobody reads, which is
  // why exactly one of these is unconditional and the rest are not.
  if (env.NODE_ENV === "production") {
    // The trusted set is stated on EVERY production boot, set or not. A proxy
    // missing from this list is the one misconfiguration the running app
    // cannot detect (see `lib/rate-limit.ts:getClientIp`), and this line is the
    // only mitigation offered for it — so it has to appear in the case an
    // operator would actually go looking at, which is the one where the value
    // IS set. Printing it only when unset would be a control described as
    // catching something it never looks at.
    //
    // The set is resolved by `resolveTrustedProxies`, the same function
    // `getClientIp` matches against — NOT by a local re-implementation. An
    // earlier version classified entries here with a bare `net.isIP` and
    // diverged from the runtime on a blank value, on a `host:port` entry and
    // on an IPv6 zone id, so the note confidently named a trusted set that was
    // not the one in force. A note that can be wrong about the one thing it
    // exists to report is worse than no note. Keep these on one function.
    const listed = trusted.addresses.size ? [...trusted.addresses].join(", ") : "(none usable)";
    add(
      "note",
      "TRUSTED_PROXIES",
      `— X-Forwarded-For entries from these addresses are stripped when identifying a client: ${listed}` +
        `${trusted.usingDefault ? " (default; the variable is unset or blank)" : ""}. ` +
        "Check that against your actual topology: if your reverse proxy's address is missing, its address is " +
        "returned as the client for everyone behind it and per-IP rate limits count all of them as one. The app " +
        "cannot detect that on its own — a correct single-proxy deployment looks identical from the inside — so " +
        "this line is the whole of the check. A proxy on this host is covered by the default."
    );

    if (trusted.invalid.length) {
      add(
        "warn",
        "TRUSTED_PROXIES",
        `contains ${trusted.invalid.length} value(s) that are not IP addresses and are ignored: ` +
          `${trusted.invalid.join(", ")}. Only plain IPv4/IPv6 literals are matched — CIDR ranges and hostnames ` +
          "are not supported."
      );
    }

    if (!env.APP_BASE_URL) {
      add(
        "note",
        "APP_BASE_URL",
        "not set — OAuth redirect URIs are derived from request headers instead of a fixed origin. Set it to this " +
          "deployment's canonical URL (e.g. https://tracker.example.com)."
      );
    }
  }

  return findings;
}

/**
 * EXPORT_ROOT and BACKUP_ROOT are deliberately not reported. They are silent
 * defaults too, but both default to a directory inside the app's own tree that
 * is correct for every supported install, and both are reachable only by an
 * authenticated Admin through a path that validates containment at use time.
 * A boot line for each would be noise on every healthy install, which is how a
 * startup check stops being read. They are documented in .env.example instead.
 */

function formatLine(finding: Finding): string {
  const label = finding.level === "fatal" ? "ERROR" : finding.level === "warn" ? "WARNING" : "note";
  return `  [${label}] ${finding.variable} ${finding.message}`;
}

export async function register(): Promise<void> {
  // `register` is evaluated for the edge runtime too, where most of these
  // variables are not present and none of this applies.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Dynamic, and inside the guard — see the module comment. A static import
  // puts `node:net` in the edge bundle and makes every successful build print
  // an "error" line into the operator-facing update log.
  const { resolveTrustedProxies } = await import("@/lib/client-ip");

  const findings = collectFindings(process.env, resolveTrustedProxies(process.env.TRUSTED_PROXIES));
  // In development a healthy install is completely silent. In production it
  // prints exactly one line — the trusted-proxy set, which is deliberately
  // unconditional; see `collectFindings`.
  if (findings.length === 0) return;

  const fatal = findings.filter((f) => f.level === "fatal");
  const rest = findings.filter((f) => f.level !== "fatal");

  const report = ["Training Tracker environment check:", ...findings.map(formatLine)].join("\n");
  if (fatal.length) console.error(report);
  else if (rest.some((f) => f.level === "warn")) console.warn(report);
  // A notes-only report is a statement of fact, not a complaint, and must not
  // be logged at a level that makes a healthy boot look like a problem.
  else console.info(report);

  if (fatal.length) {
    // See the module comment for what this throw does at runtime, and for why
    // it is a throw rather than a process.exit. The full remediation is
    // repeated into the thrown error on purpose: Next re-logs *this* message
    // on every subsequent dynamic request, so it is the text an operator is
    // most likely to be looking at — and it is also why this string is kept to
    // one paragraph rather than growing.
    const names = fatal.map((f) => f.variable).join(", ");
    throw new Error(
      `Refusing to start: ${names} ${fatal.length === 1 ? "is" : "are"} missing or invalid. ` +
        fatal.map((f) => `${f.variable} ${f.message}`).join(" ") +
        (rest.length ? ` (${rest.length} further warning(s) reported above.)` : "")
    );
  }
}
