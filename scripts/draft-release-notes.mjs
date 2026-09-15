#!/usr/bin/env node
/**
 * Draft release notes from the merge history in a range.
 *
 * ## Why this exists
 *
 * Every task used to hand-write `.github/releases/<tag>.md`, because every merge
 * into `dev` published its own pre-release. That produced 64 GitHub releases in
 * a week and a notes file per bug fix, and it meant a stable release had to be
 * assembled by reading back a dozen dev notes files and de-duplicating them.
 *
 * `dev` no longer cuts releases, so notes are written once, when a build is cut.
 * This script produces the first draft of that file from the pull requests that
 * actually landed in the range.
 *
 * ## Why git log and not the API
 *
 * Pull requests merge into `dev` with a squash, so each one is a single commit
 * whose subject is the PR title with `(#N)` appended:
 *
 *     Collapse nested OLX sub-items to one row per Full Title (#56)
 *
 * That is already the changelog line. Reading it from `git log` means no token,
 * no rate limit, and no network — which matters because GitHub's GraphQL API is
 * blocked from these sessions and the REST call would need credentials the
 * script should not require.
 *
 * ## The output is a DRAFT
 *
 * It is a starting point to edit, not a finished release body. In particular the
 * De-identification rules in CLAUDE.md still apply: read every line before it
 * ships, because a PR title naming a real company, product or person would
 * otherwise ride straight out to a public release.
 *
 * Usage:
 *   node scripts/draft-release-notes.mjs                      # since the last tag
 *   node scripts/draft-release-notes.mjs --from v3.29 --to dev
 *   node scripts/draft-release-notes.mjs --from v3.29 > .github/releases/v3.30.0.md
 */

import { execFileSync } from "node:child_process";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const to = arg("to", "HEAD");

let from = arg("from");
if (!from) {
  try {
    from = git(["describe", "--tags", "--abbrev=0", "--match", "v*", to]);
  } catch {
    console.error(
      "Could not find a previous tag to start from. Pass one explicitly:\n" +
        "  node scripts/draft-release-notes.mjs --from v3.29 --to dev\n"
    );
    process.exit(1);
  }
}

let subjects;
try {
  // --no-merges: a promotion merge commit ("Merge branch 'dev' into master") is
  // not a change, and the squashed commits it brings along are listed anyway.
  subjects = git(["log", "--no-merges", "--pretty=%s", `${from}..${to}`])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
} catch {
  console.error(
    `Could not read the history ${from}..${to}. Both refs must exist locally — ` +
      `try 'git fetch --tags origin' first.\n`
  );
  process.exit(1);
}

// Release-notes and version-bump commits describe the release rather than
// belonging in it.
const NOISE = /^(add(ed)?|write|update)\b.*\brelease notes\b/i;
const changes = subjects.filter((s) => !NOISE.test(s));

if (!changes.length) {
  console.error(`No changes found in ${from}..${to}.\n`);
  process.exit(1);
}

const lines = [];
lines.push(`<!-- DRAFT from ${from}..${to} — ${changes.length} change(s).`);
lines.push("     Edit before shipping: group related items, drop anything that");
lines.push("     is not user-facing, and rewrite each line for someone who does");
lines.push("     not know the codebase.");
lines.push("");
lines.push("     Check every line against the De-identification rules in");
lines.push("     CLAUDE.md before this goes out as a public release. -->");
lines.push("");
lines.push("## What's new");
lines.push("");
for (const s of changes) lines.push(`- ${s}`);
lines.push("");

console.log(lines.join("\n"));
