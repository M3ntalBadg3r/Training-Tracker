#!/usr/bin/env node
/**
 * De-identification scan — an advisory pass over the lines a change ADDS,
 * backing the Data Hygiene & De-identification section of CLAUDE.md.
 *
 * ## Why this exists
 *
 * This is a generic, multi-tenant product, but it is developed against one
 * real installation's data. Real company, partner, product and program names —
 * and real people's names and addresses — reach the repo through exactly three
 * doors: example values in code and comments, the user-facing docs
 * (`README.md`, `src/lib/help-content.tsx`), and release notes, which are
 * published to the world by `release.yml` seconds after the push. The rule
 * covering all three is prose, checked by eye, at the end of a task.
 *
 * ## Why it is advisory, not blocking
 *
 * It is a heuristic. It reports, it never fails the build, and it is not a
 * required status check — a false positive must not be able to stop a release.
 * Read its findings, then decide.
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
 * request template.
 *
 * Usage:
 *   GITHUB_BASE_REF=dev node scripts/check-deidentification.mjs
 *   node scripts/check-deidentification.mjs --base master
 *
 * Always exits 0.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const argBase = (() => {
  const i = process.argv.indexOf("--base");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const base = argBase || process.env.GITHUB_BASE_REF || "dev";

/** The fictional domains CLAUDE.md prescribes for examples, plus local ones. */
const ALLOWED_DOMAINS = new Set([
  "co.com",
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
  console.log(`Could not diff against ${base} — de-identification scan skipped.`);
  process.exit(0);
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
    `### De-identification scan — ${findings.length} thing(s) to look at`,
    "",
    "Advisory only; this check never fails. Confirm each is a fictional " +
      "placeholder before merging.",
    "",
    "| File | Line | Finding |",
    "| --- | --- | --- |"
  );
  for (const f of findings) {
    console.log(
      `::warning file=${f.file},line=${f.line}::De-identification: ${f.what}. ${f.hint}`
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
  console.log(
    `\nDe-identification scan: ${findings.length} advisory finding(s) — see the annotations above.`
  );
} else {
  summary.push(
    "### De-identification scan — clean",
    "",
    "No email addresses outside the fictional domains and no home-directory " +
      "paths in the added lines. Real company, product, partner-program and " +
      "person names are not machine-detectable here — confirm those by eye."
  );
  console.log("De-identification scan clean — no shape-level findings in the added lines.");
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
}

process.exit(0);
