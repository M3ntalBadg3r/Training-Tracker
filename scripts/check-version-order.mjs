#!/usr/bin/env node
/**
 * Version comparator fixtures — run on every invocation, like the other
 * scripts/check-*.mjs scanners.
 *
 * ## Why this exists
 *
 * `deploy/lib/version.mjs` decides whether an installed system is offered an
 * update. Get it wrong in the permissive direction and boxes rebuild in a loop;
 * get it wrong in the strict direction and they silently stop updating, which is
 * the failure mode this project keeps rediscovering — nothing raises, nothing
 * logs, the work just stops.
 *
 * The comparator replaced five hand-rolled copies of `major * 1000 + minor`
 * that had already drifted apart, so the important assertion is not "semver is
 * implemented correctly" in the abstract. It is **that the ~100 tags already
 * published keep the order the old comparator gave them** — a box that has not
 * updated yet is still running the old one, and a reordering would strand it.
 *
 * Run: npm run check:version
 */

import { compareVersions, parseVersion, isNewerVersion } from "../deploy/lib/version.mjs";

let failures = 0;

function check(description, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${description}\n        expected ${expected}, got ${actual}`);
  }
  return ok;
}

/** Assert a < b, and that the reverse and the self-comparison agree. */
function ascending(a, b) {
  check(`${a} < ${b}`, compareVersions(a, b), -1);
  check(`${b} > ${a}`, compareVersions(b, a), 1);
  check(`${a} == ${a}`, compareVersions(a, a), 0);
}

// ---------------------------------------------------------------------------
// 1. Core semver ordering
// ---------------------------------------------------------------------------

ascending("3.30.0", "3.30.1");
ascending("3.30.1", "3.31.0");
ascending("3.31.0", "4.0.0");
ascending("3.9.0", "3.10.0"); // numeric, not lexical
ascending("3.30.0", "3.30.10");

// Semver §11: a prerelease sorts below its own release.
ascending("3.30.0-beta.1", "3.30.0");
ascending("3.30.0-beta.1", "3.30.0-beta.2");
ascending("3.30.0-beta.2", "3.30.0-beta.10"); // numeric identifiers
ascending("3.30.0-alpha", "3.30.0-beta");
ascending("3.30.0-beta", "3.30.0-beta.1"); // more identifiers wins
ascending("3.30.0-1", "3.30.0-alpha"); // numeric < alphanumeric

// Build metadata is excluded from precedence (semver §10).
check("build metadata ignored", compareVersions("3.30.0+abc", "3.30.0"), 0);

// ---------------------------------------------------------------------------
// 2. Legacy formats still parse and still order
// ---------------------------------------------------------------------------

check("two-part gets patch 0", parseVersion("3.29")?.patch, 0);
check("leading v stripped", parseVersion("v3.29")?.major, 3);
check("-dev is a prerelease", parseVersion("3.29-dev")?.prerelease.length, 1);

ascending("3.29", "3.30.0"); // THE migration hop
ascending("3.29-dev", "3.29"); // deliberate change: the tie is gone
ascending("2.99", "3.00"); // the old rollover
ascending("1.01", "1.10"); // two-digit minors were numeric, so this holds

// ---------------------------------------------------------------------------
// 3. Junk never wins
// ---------------------------------------------------------------------------

check("unparseable sorts below", compareVersions("not-a-version", "1.0.0"), -1);
check("both unparseable are equal", compareVersions("junk", "junk"), 0);
check("null-ish input is total", compareVersions(undefined, "1.0.0"), -1);
check("object input is total", compareVersions({}, "1.0.0"), -1);
check("equal is not newer", isNewerVersion("3.30.0", "3.30.0"), false);

// ---------------------------------------------------------------------------
// 4. The real published tag list must not reorder
//
// This is the assertion that actually protects installed systems. The old
// comparator is reproduced verbatim; for every pair of REAL tags where it had a
// strict opinion, the new one must agree.
//
// Pre-release vs its own stable is excluded, because that pair is the one
// deliberate change (the old comparator tied them and picked arbitrarily).
// ---------------------------------------------------------------------------

/** The comparator every not-yet-updated box is still running. */
function legacyNumber(version) {
  const clean = String(version).replace(/-dev$/, "");
  const parts = clean.split(".");
  return (parseInt(parts[0] || "0", 10) * 1000) + parseInt(parts[1] || "0", 10);
}

// A representative slice of the real history, spanning the 2.x→3.x rollover.
const PUBLISHED = [
  "2.58", "2.70", "2.83", "2.90", "2.96", "2.96-dev", "2.99",
  "3.00", "3.04", "3.06", "3.06-dev", "3.07", "3.13", "3.14",
  "3.16", "3.22", "3.29", "3.29-dev", "3.30-dev",
];

let comparedPairs = 0;
for (const a of PUBLISHED) {
  for (const b of PUBLISHED) {
    if (a === b) continue;
    const legacy = Math.sign(legacyNumber(a) - legacyNumber(b));
    if (legacy === 0) continue; // old comparator had no opinion; nothing to preserve

    // Skip the one intentional divergence: X-dev vs X now orders, and did not.
    const stripped = (v) => v.replace(/-dev$/, "");
    if (stripped(a) === stripped(b)) continue;

    comparedPairs++;
    check(
      `historical order preserved: ${a} vs ${b}`,
      Math.sign(compareVersions(a, b)),
      legacy
    );
  }
}

// A corpus that silently compared nothing would report green, which is the
// exact failure this file exists to prevent elsewhere.
if (comparedPairs < 100) {
  failures++;
  console.error(
    `  FAIL  historical corpus compared only ${comparedPairs} pairs — expected >100. ` +
      `The corpus or the skip conditions are wrong.`
  );
}

// ---------------------------------------------------------------------------

if (failures) {
  console.error(`\nVersion ordering: ${failures} failure(s).\n`);
  process.exit(1);
}

console.log(
  `Version ordering OK — semver precedence, legacy formats, and ${comparedPairs} ` +
    `real historical tag pairs still order as the old comparator did.`
);
