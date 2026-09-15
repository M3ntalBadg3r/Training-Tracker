#!/usr/bin/env node
/**
 * Release hygiene check — the standing enforcement of the Mandatory Post-Change
 * Rules in CLAUDE.md.
 *
 * ## Why this exists
 *
 * These rules are mechanical and have each been missed at least once: keep
 * `package-lock.json`'s two version fields in step with `package.json`, and
 * ship `.github/releases/<tag>.md` for a release in the same commit. When one
 * is skipped the failure is silent and lands in a *release* — a missing notes
 * file means the release ships with auto-generated commit titles instead of the
 * changelog a user reads.
 *
 * Prose in CLAUDE.md is enforced only by whoever happens to be reading it. This
 * is the enforcement point.
 *
 * ## What it checks, by base branch
 *
 * Into `dev` (a normal task): only that the lockfile matches package.json, and
 * that the version has not gone backwards.
 *
 *   `dev` deliberately requires NO version bump and NO release notes. It used
 *   to demand exactly one 0.01 step plus a notes file per task, because every
 *   push to `dev` published a `v<version>-dev` pre-release. That coupling is
 *   what produced 64 GitHub releases in a week on a page customers read, and a
 *   version number that moved 2.96 -> 3.29 in four days while meaning nothing.
 *   `dev` no longer cuts releases at all (see release.yml), so a task that
 *   merges into it has nothing to version and nothing to write notes for. The
 *   version now moves once per release, when a build is actually cut.
 *
 * Into `master` (a stable release):
 *   - `.github/releases/v<version>.md` exists and is non-empty
 *   - version is > the base's — a release must move the version, or
 *     `release.yml` finds the tag already exists and quietly cuts nothing
 *
 * Both: `package-lock.json`'s `.version` and `.packages[""].version` match
 * `package.json`.
 *
 * ## Escape hatch
 *
 * Set SKIP_RELEASE_CHECKS=1 (the workflow sets it when the PR carries the
 * `skip-release-checks` label) and the script prints a notice and passes. It
 * exits 0 rather than the job being skipped, because a *skipped* required check
 * blocks a pull request just as firmly as a failing one.
 *
 * Usage:
 *   GITHUB_BASE_REF=dev node scripts/check-release-hygiene.mjs
 *   node scripts/check-release-hygiene.mjs --base master
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();

if (process.env.SKIP_RELEASE_CHECKS) {
  console.log(
    "SKIP_RELEASE_CHECKS is set (the `skip-release-checks` label) — release " +
      "hygiene not enforced for this pull request."
  );
  process.exit(0);
}

/** Base branch this change is headed into. */
const argBase = (() => {
  const i = process.argv.indexOf("--base");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const base = argBase || process.env.GITHUB_BASE_REF || "dev";

if (base !== "dev" && base !== "master") {
  console.log(
    `Base branch is "${base}", not dev or master — nothing to enforce here.`
  );
  process.exit(0);
}

/**
 * Mirrors parseVersionNumber in src/app/api/admin/updates/check/route.ts: the
 * app compares versions as major*1000 + minor. Keep the two in step — a version
 * this script accepts but the comparator orders differently would ship an update
 * clients never see.
 *
 * This is an *ordering* function and nothing more. It used to sit alongside a
 * `stepProblem` helper that defined "exactly one 0.01 task step", including the
 * x.99 -> (x+1).00 rollover. That rule is gone: merging into `dev` no longer
 * cuts a release, so there is no per-task step to enforce.
 */
function versionNumber(version) {
  const clean = String(version).replace(/-dev$/, "");
  const parts = clean.split(".");
  const major = parseInt(parts[0] || "0", 10);
  const minor = parseInt(parts[1] || "0", 10);
  return major * 1000 + minor;
}

/** Read a path as it exists on the base branch, or null when unavailable. */
function showFromBase(path) {
  for (const ref of [`origin/${base}`, base]) {
    try {
      return execFileSync("git", ["show", `${ref}:${path}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      /* try the next ref */
    }
  }
  return null;
}

const errors = [];

// ---------------------------------------------------------------------------
// package.json / package-lock.json
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = pkg.version;

if (!/^\d+\.\d{2}$/.test(String(version))) {
  errors.push(
    `package.json version is "${version}". This project uses a two-component ` +
      `major.minor scheme with a two-digit minor (e.g. "2.95"), because the ` +
      `update comparator parses exactly that.`
  );
}

const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
const lockVersions = [
  ["package-lock.json .version", lock.version],
  ['package-lock.json .packages[""].version', lock.packages?.[""]?.version],
];
for (const [label, value] of lockVersions) {
  if (value !== version) {
    errors.push(
      `${label} is "${value}" but package.json is "${version}". Both lockfile ` +
        `version fields must be kept in sync with package.json.`
    );
  }
}

// ---------------------------------------------------------------------------
// Version movement relative to the base branch
// ---------------------------------------------------------------------------

const basePkgRaw = showFromBase("package.json");
let baseVersion = null;
if (basePkgRaw) {
  try {
    baseVersion = JSON.parse(basePkgRaw).version;
  } catch {
    /* unparseable base package.json — treated as unavailable below */
  }
}

if (!baseVersion) {
  console.log(
    `Could not read package.json from ${base} — skipping the version-movement ` +
      `check (the notes and lockfile checks still ran).`
  );
} else if (base === "dev") {
  // No bump required. Merging into dev cuts no release, so there is nothing to
  // version — but going backwards is still always a mistake.
  if (versionNumber(version) < versionNumber(baseVersion)) {
    errors.push(
      `Version "${version}" is behind dev's "${baseVersion}". A change must ` +
        `not move the version backwards.`
    );
  }
} else if (versionNumber(version) <= versionNumber(baseVersion)) {
  errors.push(
    `Version "${version}" does not move past master's "${baseVersion}". A ` +
      `release must bump the version — release.yml would otherwise find tag ` +
      `v${version} already exists and cut nothing.`
  );
}

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

// Notes are required only when this change actually cuts a release.
//
// Into `master` that is always. Into `dev` it is only when the version moves:
// an ordinary task leaves the version alone and publishes nothing, but a
// version bump on `dev` still tags a `-dev` pre-release, and a release without
// curated notes ships auto-generated commit titles to whoever reads it.
const tag = base === "dev" ? `v${version}-dev` : `v${version}`;
const notesPath = join(".github", "releases", `${tag}.md`);
const notesAbs = join(ROOT, notesPath);

const cutsRelease =
  base !== "dev" || (baseVersion !== null && version !== baseVersion);

if (!cutsRelease) {
  /* ordinary task into dev — no version move, so no release and no notes */
} else if (!existsSync(notesAbs)) {
  errors.push(
    `No release notes at ${notesPath}. release.yml reads this file for the ` +
      `${tag} release; without it the release ships auto-generated commit ` +
      `titles instead of a changelog.`
  );
} else if (!readFileSync(notesAbs, "utf8").trim()) {
  errors.push(`${notesPath} is empty — write the what's-new/changed/fixed notes.`);
}

// ---------------------------------------------------------------------------

if (errors.length) {
  console.error(`\nRelease hygiene: ${errors.length} problem(s).\n`);
  for (const e of errors) console.error(`  - ${e}\n`);
  console.error(
    "These are the Mandatory Post-Change Rules in CLAUDE.md. If this pull " +
      "request genuinely ships no release, add the `skip-release-checks` " +
      "label.\n"
  );
  process.exit(1);
}

console.log(
  cutsRelease
    ? `Release hygiene OK — v${version} into ${base}, notes at ${notesPath}, ` +
        `lockfile in sync.`
    : `Release hygiene OK — v${version} into ${base} (no version move, so no ` +
        `release and no notes required), lockfile in sync.`
);
