/**
 * The Node.js security floor — the lowest release on each supported Node line
 * that carries every security fix this project knows it needs.
 *
 * ## Why this file is in deploy/ and not src/
 *
 * Same reason as `version.mjs` beside it: `lib/common.sh:ensure_node_runtime`
 * runs as **root** and reads this table to decide whether to upgrade the host's
 * `nodejs` package, and root must never import a module the unprivileged app
 * can rewrite. `deploy/` is root-owned; `src/lib/node-runtime.ts` re-exports
 * this at build time so the app's warnings (Admin › Updates, the boot check)
 * read the very same table.
 *
 * ## Raising a floor
 *
 * When Node publishes a security release that affects this app, raise the entry
 * for each line to that line's fixed version and ship it in a release. Every
 * install that takes the update then upgrades its own `nodejs` package during
 * the update (see `ensure_node_runtime`), and anything that cannot is told so
 * on Admin › Updates. Nothing else needs to change.
 *
 * A line NOT in the table is reported as unsupported: odd-numbered lines never
 * become LTS and reach end of life within months, and a line below the
 * project's minimum (22) cannot build the app at all.
 *
 * ## Zero imports beyond `version.mjs`
 *
 * It is imported by root via `node --input-type=module` with the path passed as
 * an argument, by `src/instrumentation.ts` before anything else has loaded, and
 * by a client-free route. Keep it dependency-free.
 */

import { compareVersions, parseVersion } from "./version.mjs";

/**
 * Lowest acceptable release per supported major line.
 *
 * 2026-10 (October 2026 Node.js security releases): Brotli decoder
 * out-of-bounds write, TLS hostname checks on non-canonical IPv4, keep-alive
 * response confusion, plus a CA-store update.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const NODE_SECURITY_FLOORS = Object.freeze({
  22: "22.23.4",
  24: "24.22.1",
  26: "26.12.1",
});

/**
 * @typedef {object} NodeAssessment
 * @property {"ok" | "belowFloor" | "unsupported" | "unknown"} status
 * @property {string} version  The version assessed, without a leading `v`.
 * @property {number | null} major
 * @property {string | null} floor  The floor for this line, when it has one.
 */

/**
 * Classify a Node version against the floor table.
 *
 * Total: the input is a version string from `process.versions.node` or from
 * `node -p` run by root, and a throw here would turn a warning into an outage.
 *
 * @param {string} input  e.g. "22.22.0" or "v22.22.0"
 * @returns {NodeAssessment}
 */
export function assessNodeVersion(input) {
  const version = typeof input === "string" ? input.trim().replace(/^v/, "") : "";
  const parsed = parseVersion(version);
  if (!parsed) return { status: "unknown", version, major: null, floor: null };

  const floor = Object.prototype.hasOwnProperty.call(NODE_SECURITY_FLOORS, parsed.major)
    ? NODE_SECURITY_FLOORS[parsed.major]
    : null;
  if (floor === null) {
    return { status: "unsupported", version, major: parsed.major, floor: null };
  }
  return {
    status: compareVersions(version, floor) < 0 ? "belowFloor" : "ok",
    version,
    major: parsed.major,
    floor,
  };
}

/**
 * The upstream part of a Debian package version: `1:22.23.4-1nodesource1` and
 * `22.23.4-ns6.3.9` both give `22.23.4`. Used by root to compare an apt
 * candidate against the floor before installing it.
 *
 * @param {string} debVersion
 * @returns {string}
 */
export function upstreamOfDebianVersion(debVersion) {
  if (typeof debVersion !== "string") return "";
  let v = debVersion.trim();
  const epoch = v.indexOf(":");
  if (epoch !== -1) v = v.slice(epoch + 1);
  const rev = v.indexOf("-");
  if (rev !== -1) v = v.slice(0, rev);
  return v;
}
