/**
 * The project's version comparator — one implementation, used by both sides.
 *
 * ## Why this file is in deploy/ and not src/
 *
 * `deploy/check-update.sh` runs as **root**, from cron, and needs this logic.
 * `src/` is **service-user-owned** (see the ownership invariant in CLAUDE.md), so
 * having root import a module the unprivileged app can rewrite would be root
 * code execution on demand — the same escalation the request-file boundary and
 * the never-`source`-`.env` rule exist to prevent. `deploy/` is root-owned and
 * `go-w`, and already hosts the other cross-boundary primitive
 * (`lib/cron-sign.sh`).
 *
 * `src/lib/version.ts` re-exports this, so the app and the root scripts share
 * ONE implementation rather than a mirrored pair plus a parity check. That is
 * strictly better than the `cron-sign.sh` precedent, which only duplicates
 * because bash cannot call TypeScript. Node can.
 *
 * ## What it replaced
 *
 * Five copies of `major * 1000 + minor`, which had already drifted apart:
 * `updates/check/route.ts` discarded `parts[2]`; the inline `node -e` in
 * `check-update.sh` *summed* it (so `2.96.3` and `2.99` both scored 2099);
 * `switch-channel/route.ts` did not strip `-dev`; and an `awk` `printf
 * "%d%03d"` dropped it again. The encoding also capped the minor at 99 and had
 * no way to express a patch release at all.
 *
 * ## Compatibility with the ~100 tags already published
 *
 * Accepts a leading `v`, a legacy two-part version (`3.29` → `3.29.0`) and the
 * legacy `-dev` suffix. The old scheme's minor was always numeric, so semver
 * orders the historical tags identically — `scripts/check-version-order.mjs`
 * asserts that over the real list rather than assuming it.
 *
 * One deliberate change: `v3.29-dev` now sorts BELOW `v3.29`, where the old
 * comparator tied them and let whichever GitHub returned first win. That is the
 * correct direction (the dev pre-release did precede the stable release), and
 * the tie was documented as a known wart.
 *
 * ## The migration constraint — LIFTED as of v3.33.1, kept as history
 *
 * An installed box runs the OLD comparator until it takes an update, and that
 * comparator reads only `major * 1000 + minor`. So `3.30.0` (3030) is visible to
 * a box on `3.29` (3029), but `3.29.1` also scores 3029 — a tie, and the
 * comparison is strict `>`, so it would be invisible forever.
 *
 * That is why every stable release from 3.30.0 to 3.33.0 moved the MINOR even
 * for a bug-fix-only range. **The constraint is now lifted**: the install base
 * is on ≥ 3.30.0, so every box runs this comparator and patch releases are
 * visible. Version numbers are plain semver again — patch for fixes.
 *
 * **What would bring it back.** A box below 3.30.0 surfacing — a long-dormant
 * install, a restore from an old image. Such a box cannot see ANY patch release,
 * permanently and silently: delivery is a branch pull so its code would be fine,
 * it would simply stop being offered updates. There is no telemetry to detect
 * one, so this is an operator's judgement, not something CI can check. The fix
 * is to get it past 3.30.0 by any route — one minor release, or a manual
 * `git pull` + `deploy/update.sh` on the box itself — after which patch releases
 * reach it normally. Do not re-impose a blanket minor-bump rule for one box.
 */

/**
 * @typedef {object} ParsedVersion
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {(string|number)[]} prerelease Empty for a release version.
 */

/** Matches `1.2`, `1.2.3`, with optional `v`, `-prerelease` and `+build`. */
const VERSION_RE =
  /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parse a version string, or return null when it is not one.
 *
 * Total by construction: the only inputs are tag names from the GitHub API and
 * a `package.json` field the service user can write, so a throw here would turn
 * an update check into a 500 on a value an attacker partly controls.
 *
 * @param {string} input
 * @returns {ParsedVersion | null}
 */
export function parseVersion(input) {
  if (typeof input !== "string") return null;
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;

  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    // Build metadata is deliberately dropped: semver §10 excludes it from
    // precedence, so two versions differing only by build compare equal.
    prerelease: m[4] === undefined ? [] : m[4].split(".").map(identifier),
  };
}

/** A numeric prerelease identifier compares numerically; anything else as text. */
function identifier(part) {
  return /^\d+$/.test(part) ? Number(part) : part;
}

/**
 * Semver precedence. Returns -1, 0 or 1.
 *
 * Unparseable input sorts BELOW anything parseable (and two unparseable values
 * compare equal), so junk can never be selected as "the newest release".
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  for (const key of /** @type {const} */ (["major", "minor", "patch"])) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }

  // Semver §11: a version WITH a prerelease has lower precedence than the same
  // version without one. 3.30.0-beta.1 < 3.30.0.
  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  for (let i = 0; i < Math.max(aPre.length, bPre.length); i++) {
    const x = aPre[i];
    const y = bPre[i];
    // A larger set of identifiers wins when all preceding ones are equal.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;

    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }

  return 0;
}

/**
 * Is `candidate` a strictly newer version than `current`?
 *
 * Strict on purpose — an equal version is not an update, and offering one would
 * loop a box through a pointless rebuild on every check.
 *
 * @param {string} candidate
 * @param {string} current
 * @returns {boolean}
 */
export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

/**
 * Strip a leading `v` from a tag to get the version it names.
 *
 * @param {string} tag
 * @returns {string}
 */
export function versionFromTag(tag) {
  return String(tag || "").replace(/^v/, "");
}

/** Is this a prerelease version (`3.31.0-beta.1`, `3.29-dev`)? */
export function isPrereleaseVersion(input) {
  const parsed = parseVersion(input);
  return parsed !== null && parsed.prerelease.length > 0;
}
