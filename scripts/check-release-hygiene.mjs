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
 *   `dev` requires NO version bump and NO release notes, because `dev` is not a
 *   release.yml trigger and so publishes nothing. It used to demand exactly one
 *   0.01 step plus a notes file per task, because every push to `dev` published
 *   a `v<version>-dev` pre-release. That coupling produced 64 GitHub releases in
 *   a week on a page customers read, and a version number that moved 2.96 ->
 *   3.29 in four days while meaning nothing. The version now moves once per
 *   release, when a build is actually cut.
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
import { compareVersions, parseVersion } from "../deploy/lib/version.mjs";

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
 * Ordering comes from the SAME module the app and the root update scripts use
 * (`deploy/lib/version.mjs`), rather than a fourth hand-rolled copy of it. This
 * file used to carry its own `major*1000 + minor` with a comment asking the next
 * person to keep it in step with `updates/check/route.ts` — which is precisely
 * the arrangement that let five copies drift apart.
 *
 * It used to sit alongside a `stepProblem` helper defining "exactly one 0.01
 * task step", including the x.99 -> (x+1).00 rollover. That rule is gone:
 * merging into `dev` no longer cuts a release, so there is no per-task step.
 */

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

// Semver: MAJOR.MINOR.PATCH. The old gate demanded a two-digit minor
// (`/^\d+\.\d{2}$/`) because the comparator encoded `major*1000 + minor`, which
// could not express a patch release at all and capped the minor at 99.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
  errors.push(
    `package.json version is "${version}". This project uses semver ` +
      `(MAJOR.MINOR.PATCH, e.g. "3.30.0") — patch for fixes, minor for ` +
      `features, major for breaking changes.`
  );
} else if (parseVersion(version) === null) {
  // Belt and braces: the gate above and the comparator must agree on what a
  // version is, or this check could pass something the updater cannot order.
  errors.push(
    `package.json version "${version}" matched the format gate but could not ` +
      `be parsed by deploy/lib/version.mjs. The two must agree.`
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
  if (compareVersions(version, baseVersion) < 0) {
    errors.push(
      `Version "${version}" is behind dev's "${baseVersion}". A change must ` +
        `not move the version backwards.`
    );
  }
} else if (compareVersions(version, baseVersion) <= 0) {
  errors.push(
    `Version "${version}" does not move past master's "${baseVersion}". A ` +
      `release must bump the version — release.yml would otherwise find tag ` +
      `v${version} already exists and cut nothing.`
  );
}

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

// Notes are required only when this change actually cuts a release, which is
// now exactly "into master". `dev` is not a release.yml trigger at all, so
// nothing merged into `dev` publishes anything — not even a version bump. The
// stable notes file therefore lands on `dev` like any other file, through an
// ordinary PR, and is read by release.yml when the promotion reaches master.
//
// (That also retires the one documented use of the `skip-release-checks` label:
// the stable-notes PR into `dev` used to need it, because this check demanded a
// version step that the promotion deliberately did not have.)
const tag = `v${version}`;
const notesPath = join(".github", "releases", `${tag}.md`);
const notesAbs = join(ROOT, notesPath);

const cutsRelease = base !== "dev";

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
    : `Release hygiene OK — v${version} into ${base} (publishes no release, so ` +
        `no bump and no notes required), lockfile in sync.`
);
