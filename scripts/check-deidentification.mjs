#!/usr/bin/env node
/**
 * De-identification scan — a blocking pass over the lines a change ADDS,
 * backing the Data Hygiene & De-identification section of CLAUDE.md.
 *
 * ## Why this exists
 *
 * This is a generic, multi-tenant product, but it is developed against one
 * real installation's data. Real company, partner, product and program names —
 * and real people's names and addresses — reach the repo through exactly three
 * doors: example values in code and comments, the user-facing docs
 * (`README.md`, `src/lib/help-content.tsx`), and release notes, which are
 * published to the world by `release.yml` seconds after the merge.
 *
 * ## Why it blocks (it used to be advisory)
 *
 * It shipped advisory — report, never fail — on the reasoning that a heuristic
 * should not be able to stop a release over a false positive. That reasoning
 * assumed a person would read the findings on the pull request and decide.
 *
 * Nobody does. The pipeline is unattended end to end: the PR opens itself,
 * auto-merges on green, and `release.yml` publishes the release. An advisory
 * check with no reader is not a soft check, it is no check at all, and its
 * findings would reach a public GitHub release unread. So it fails the job,
 * and the escape hatch below is how a false positive gets past it — a decision
 * someone makes on purpose, rather than a warning nobody sees.
 *
 * ## Escape hatch
 *
 * Set SKIP_DEID_SCAN=1 — the workflow sets it when the PR carries the
 * `skip-deid-scan` label — and the script prints a notice and passes. Like
 * `check-release-hygiene.mjs` it exits 0 rather than being `if:`-skipped,
 * because a *skipped* required check blocks a PR just as firmly as a failing
 * one.
 *
 * ## Why there is no list of real names to grep for
 *
 * That is the obvious design and it is self-defeating: a denylist of the real
 * customer, partner and product names would be a file in this repo containing
 * the exact identifiers the policy exists to keep out of it — committed, public
 * and permanent. So the scan only looks for shapes that are wrong regardless of
 * which name fills them:
 *
 *   1. email addresses outside the fictional domains CLAUDE.md prescribes
 *   2. absolute home-directory paths, which leak a real account name
 *
 * Judgement about names stays with the human and the checklist in the pull
 * request template. **Passing this check is not a de-identification review.**
 *
 * Usage:
 *   GITHUB_BASE_REF=dev node scripts/check-deidentification.mjs
 *   node scripts/check-deidentification.mjs --base master
 *
 * Exits 1 when it finds something, 0 otherwise.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

if (process.env.SKIP_DEID_SCAN) {
  console.log(
    "SKIP_DEID_SCAN is set (the `skip-deid-scan` label) — de-identification " +
      "scan not enforced for this pull request."
  );
  process.exit(0);
}

const argBase = (() => {
  const i = process.argv.indexOf("--base");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const base = argBase || process.env.GITHUB_BASE_REF || "dev";

/**
 * The fictional domains CLAUDE.md prescribes for examples, plus local ones.
 * `company.com` is here because README.md and src/lib/help-content.tsx already
 * use `jane.doe@company.com` to explain name-derivation: it identifies nobody,
 * and rewriting published help text to satisfy a lint would be the wrong way
 * round. Keep this list in step with the Data Hygiene section of CLAUDE.md.
 */
const ALLOWED_DOMAINS = new Set([
  "co.com",
  "company.com",
  "example.com",
  "example.org",
  "example.net",
  "localhost",
]);

/**
 * Requires a local part before the "@", so npm scopes ("@prisma/client"), path
 * aliases ("@/components") and CSS at-rules ("@media") cannot match. Requires an
 * alphabetic TLD, so version specs ("next@16.2.1") cannot either.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

/**
 * True when the "@" sits inside a URL's authority rather than in an address —
 * `https://x-access-token:${TOKEN}@github.com/owner/repo`. That shape is all
 * over deploy/, it is credentials-in-a-URL and not a person, and it is the one
 * false positive guaranteed to recur. A "://" earlier in the line with no
 * whitespace between it and the match is what distinguishes the two.
 */
function insideUrlAuthority(text, index) {
  const before = text.slice(0, index);
  const scheme = before.lastIndexOf("://");
  return scheme !== -1 && !/\s/.test(before.slice(scheme + 3));
}

/** /home/<name> or /Users/<name> — "user" is this environment's own generic. */
const HOME_PATH = /\/(?:home|Users)\/([A-Za-z][A-Za-z0-9._-]{1,31})\b/g;
const ALLOWED_HOME_NAMES = new Set(["user", "runner", "root", "training-tracker"]);

/** Paths whose churn is machine-generated and never carries prose. */
const SKIP_FILES = new Set(["package-lock.json"]);

function diff() {
  for (const ref of [`origin/${base}`, base]) {
    try {
      return execFileSync(
        "git",
        ["diff", "--unified=0", "--no-color", `${ref}...HEAD`],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }
      );
    } catch {
      /* try the next ref */
    }
  }
  return null;
}

const patch = diff();
if (patch === null) {
  // Fail closed: this is a required check, and "I could not look" must not read
  // as "I looked and it was clean".
  console.error(
    `Could not diff against ${base} — the de-identification scan did not run.\n` +
      `Fetch the base branch first:\n` +
      `  git fetch --no-tags origin +refs/heads/${base}:refs/remotes/origin/${base}\n`
  );
  process.exit(1);
}

/** Walk the unified diff, collecting added lines with their file and line number. */
const findings = [];
let file = null;
let lineNo = 0;

for (const raw of patch.split("\n")) {
  if (raw.startsWith("+++ ")) {
    const path = raw.slice(4).trim();
    file = path === "/dev/null" ? null : path.replace(/^b\//, "");
    continue;
  }
  if (raw.startsWith("@@")) {
    const m = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    lineNo = m ? parseInt(m[1], 10) : 0;
    continue;
  }
  if (!raw.startsWith("+") || raw.startsWith("+++")) continue;

  const text = raw.slice(1);
  const current = lineNo;
  lineNo += 1;

  if (!file || SKIP_FILES.has(file)) continue;

  for (const m of text.matchAll(EMAIL)) {
    const domain = m[1].toLowerCase();
    if (ALLOWED_DOMAINS.has(domain)) continue;
    if (insideUrlAuthority(text, m.index)) continue;
    findings.push({
      file,
      line: current,
      what: `email address at a non-fictional domain (${domain})`,
      hint: "Use jane.doe@co.com / john.smith@example.com instead.",
    });
  }

  for (const m of text.matchAll(HOME_PATH)) {
    if (ALLOWED_HOME_NAMES.has(m[1].toLowerCase())) continue;
    findings.push({
      file,
      line: current,
      what: `absolute home-directory path naming an account (${m[0]})`,
      hint: "Use a relative path or a placeholder such as /home/user.",
    });
  }
}

const summary = [];
if (findings.length) {
  summary.push(
    `### De-identification scan — ${findings.length} finding(s)`,
    "",
    "This check blocks. Replace each with a fictional placeholder, or — if it " +
      "is a false positive — add the `skip-deid-scan` label to the pull request.",
    "",
    "| File | Line | Finding |",
    "| --- | --- | --- |"
  );
  for (const f of findings) {
    console.log(
      `::error file=${f.file},line=${f.line}::De-identification: ${f.what}. ${f.hint}`
    );
    summary.push(`| \`${f.file}\` | ${f.line} | ${f.what} |`);
  }
  summary.push(
    "",
    "See **Data Hygiene & De-identification** in `CLAUDE.md`. Note that real " +
      "company, product, partner-program and person names are *not* detected " +
      "here — deliberately, since a denylist of them would itself have to live " +
      "in this repo. Those stay a human check."
  );
} else {
  summary.push(
    "### De-identification scan — clean",
    "",
    "No email addresses outside the fictional domains and no home-directory " +
      "paths in the added lines. Real company, product, partner-program and " +
      "person names are not machine-detectable here — passing this check is " +
      "not a de-identification review."
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
}

if (findings.length) {
  console.error(
    `\nDe-identification scan: ${findings.length} finding(s) — see the annotations above.\n` +
      `Fix them, or add the \`skip-deid-scan\` label if they are false positives.\n`
  );
  process.exit(1);
}

console.log("De-identification scan clean — no shape-level findings in the added lines.");
