#!/usr/bin/env node
/**
 * Release hygiene check — the standing enforcement of the Mandatory Post-Change
 * Rules in CLAUDE.md.
 *
 * ## Why this exists
 *
 * Three of those rules are mechanical, and all three have been missed at least
 * once: bump `package.json` by exactly 0.01, keep `package-lock.json`'s two
 * version fields in step, and ship `.github/releases/<tag>.md` in the same
 * commit. When any one is skipped the failure is silent and lands in a
 * *release* — a skipped bump means `release.yml` finds the tag already exists
 * and quietly cuts nothing, and a missing notes file means the release ships
 * with auto-generated commit titles instead of the changelog a user reads.
 *
 * Prose in CLAUDE.md is enforced only by whoever happens to be reading it. This
 * is the enforcement point.
 *
 * ## What it checks, by base branch
 *
 * Into `dev` (a normal task):
 *   - version is exactly one 0.01 step above the base branch's version
 *   - `.github/releases/v<version>-dev.md` exists and is non-empty
 *
 * Into `master` (a stable promotion):
 *   - `.github/releases/v<version>.md` exists and is non-empty
 *   - version is >= the base's (a promotion rolls up several dev bumps, so the
 *     0.01 rule does not apply)
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
 * app compares versions as major*1000 + minor, so "one 0.01 step" is "+1" in
 * that space. Keep the two in step — a version this script accepts but the
 * comparator orders differently would ship an update clients never see.
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
  const from = versionNumber(baseVersion);
  const to = versionNumber(version);
  if (to !== from + 1) {
    errors.push(
      `Version must move by exactly 0.01 for one task: ${base} is ` +
        `"${baseVersion}", this branch is "${version}". ` +
        (to <= from
          ? "It has not been bumped (or has gone backwards) — release.yml " +
            "would find the tag already exists and cut nothing."
          : "It has skipped a number — every version between the two would " +
            "be missing from the release history.")
    );
  }
} else if (versionNumber(version) < versionNumber(baseVersion)) {
  errors.push(
    `Version "${version}" is behind master's "${baseVersion}". A promotion ` +
      `must not move the version backwards.`
  );
}

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

const tag = base === "dev" ? `v${version}-dev` : `v${version}`;
const notesPath = join(".github", "releases", `${tag}.md`);
const notesAbs = join(ROOT, notesPath);

if (!existsSync(notesAbs)) {
  errors.push(
    `No release notes at ${notesPath}. release.yml reads this file for the ` +
      `${tag} release; without it the release ships auto-generated commit ` +
      `titles instead of a changelog.`
  );
} else if (!readFileSync(notesAbs, "utf8").trim()) {
  errors.push(`${notesPath} is empty — write the what's-new/changed/fixed notes.`);
} else if (base === "master") {
  // A stable release is the only notes a stable user ever sees, so it must roll
  // up every dev pre-release since the last stable. We cannot verify the prose,
  // but we can catch the common miss: a stable body that is a verbatim copy of
  // a single dev notes file.
  const stable = readFileSync(notesAbs, "utf8").trim();
  const devNotes = join(ROOT, ".github", "releases", `v${version}-dev.md`);
  if (existsSync(devNotes) && readFileSync(devNotes, "utf8").trim() === stable) {
    errors.push(
      `${notesPath} is identical to v${version}-dev.md. Stable notes must ` +
        `aggregate every dev pre-release since the previous stable — see ` +
        `"Stable release notes MUST aggregate..." in CLAUDE.md.`
    );
  }
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
  `Release hygiene OK — v${version} into ${base}, notes at ${notesPath}, ` +
    `lockfile in sync.`
);
