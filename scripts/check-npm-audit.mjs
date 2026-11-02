#!/usr/bin/env node
/**
 * npm audit gate — every advisory in the dependency tree is either fixed or
 * written down here with a reason.
 *
 * ## Why this exists
 *
 * Nothing used to run `npm audit`. CLAUDE.md recorded four accepted advisories,
 * all under the `prisma` CLI, and by the time anyone looked again the tree held
 * fifteen, one critical, several in packages loaded at runtime. Updates ship
 * dependency fixes perfectly well (the lockfile travels with every release);
 * what was missing was anything that *noticed* an advisory existed. A
 * convention nothing checks is a convention that applies to whoever remembers
 * it — the same lesson as `check:url-state` and `check:routes`.
 *
 * ## What it asserts
 *
 *   1. Every advisory `npm audit` reports is listed in ACCEPTED. A new one
 *      fails: fix it (bump the package) or add an entry saying why it stays.
 *   2. Every ACCEPTED entry is still reported. One that no longer is has been
 *      fixed upstream or by a bump — delete the line. The list only shrinks by
 *      someone noticing, and this is the noticing.
 *   3. A run that could not audit fails. `npm audit` needs the registry; an
 *      error answer must never read as "no advisories".
 *
 * ## Scope: the whole tree, dev dependencies included
 *
 * Deliberately NOT `--omit=dev`. Installed systems run `npm install` without
 * `--omit=dev` (the build needs Tailwind, TypeScript and Prisma), so dev
 * dependencies are installed — and their install scripts run — on customers'
 * servers. Whether a dev-only advisory matters is a judgement for its ACCEPTED
 * entry, not something to filter out unseen.
 *
 * Every severity counts, low included: severity is npm's guess at impact in
 * the abstract, and the entry's reason is where impact in THIS app is decided.
 *
 * ## Not covered
 *
 * `xlsx` is installed from the vendor's CDN, not the registry, so `npm audit`
 * cannot see it at all — see the Deployment section of CLAUDE.md. A clean run
 * here says nothing about it.
 *
 * Run: npm run check:audit
 */

import { execFileSync } from "node:child_process";

/**
 * Advisories that stay, and why. Keyed on the advisory id (GHSA) AND the
 * package, because one advisory can name several packages and accepting it for
 * one is not accepting it for all.
 *
 * Each entry says why the vulnerable code is not reachable here (or not worth
 * the cost of the fix), and `recheck` says what should make someone look again.
 */
const ACCEPTED = [
  {
    id: "GHSA-c475-qrg2-pj4r",
    package: "basic-ftp",
    reason:
      "Runtime dependency of box-node-sdk, via proxy-agent -> pac-proxy-agent -> get-uri. " +
      "basic-ftp is only used when a PAC proxy script is fetched over ftp://, and the app " +
      "never gives the Box SDK a proxy configuration (export-destinations.ts). get-uri pins " +
      "basic-ftp ^5, so the fixed 6.x is out of range; npm's suggested fix is a downgrade of " +
      "box-node-sdk to 3.x.",
    recheck: "a box-node-sdk or get-uri release that moves to basic-ftp >= 6.2.1, or the app configuring a proxy for Box",
  },
  {
    id: "GHSA-g3hv-75wg-m249",
    package: "minimatch",
    reason:
      "Dev-only, via eslint 9 and its plugins, which pin minimatch ^3 / ^10. ESLint runs in " +
      "CI, never on an installed system (Next 16's build does not lint), and the patterns it " +
      "matches are this repository's own config, not input from anyone else.",
    recheck: "ESLint 10 (or eslint-config-next moving to a minimatch >= 11.0.1)",
  },
];

/**
 * Flatten `npm audit --json` (v7+ format) into one entry per (advisory,
 * package). `via` holds either advisory objects (the package is itself
 * vulnerable) or package-name strings (vulnerable only through a dependency);
 * only the objects are advisories — the strings are the same advisory seen from
 * a parent, and counting them would make one fix look like five.
 */
export function collectAdvisories(audit) {
  if (!audit || typeof audit !== "object" || audit.error || !audit.vulnerabilities || !audit.metadata) {
    const detail = audit && audit.error ? `: ${audit.error.summary || audit.error.code || "unknown error"}` : "";
    throw new Error(`npm audit did not return a report${detail}`);
  }
  const seen = new Map();
  for (const vuln of Object.values(audit.vulnerabilities)) {
    for (const via of vuln.via || []) {
      if (!via || typeof via !== "object") continue;
      const url = typeof via.url === "string" ? via.url : "";
      const id = url.split("/").pop() || `npm-${via.source}`;
      const key = `${id}|${via.name}`;
      if (!seen.has(key)) {
        seen.set(key, {
          id,
          package: via.name,
          severity: via.severity,
          title: via.title || "",
          range: via.range || "",
          url,
        });
      }
    }
  }
  return [...seen.values()];
}

/** Compare what audit reported against ACCEPTED. */
export function evaluate(advisories, accepted) {
  const keyOf = (a) => `${a.id}|${a.package}`;
  const acceptedKeys = new Set(accepted.map(keyOf));
  const reportedKeys = new Set(advisories.map(keyOf));
  return {
    unaccepted: advisories.filter((a) => !acceptedKeys.has(keyOf(a))),
    stale: accepted.filter((a) => !reportedKeys.has(keyOf(a))),
  };
}

// ---------------------------------------------------------------------------
// Self-tests — run on every invocation, like the other scripts/check-*.mjs.
// The checker is the guarantee, so something has to check the checker.
// ---------------------------------------------------------------------------

function selfTest() {
  const failures = [];
  const expect = (name, ok) => { if (!ok) failures.push(name); };

  const report = (vulnerabilities) => ({ vulnerabilities, metadata: { vulnerabilities: {} } });
  const adv = (id, name) => ({
    source: 1, name, title: `t-${id}`, severity: "high", range: "<1",
    url: `https://github.com/advisories/${id}`,
  });

  // An advisory listed under its own package counts; the string form seen from
  // a parent package does not double it.
  const a = collectAdvisories(report({
    child: { via: [adv("GHSA-1", "child")] },
    parent: { via: ["child"] },
  }));
  expect("collect: one advisory, not two", a.length === 1 && a[0].id === "GHSA-1" && a[0].package === "child");

  // One advisory naming two packages is two entries.
  const b = collectAdvisories(report({
    x: { via: [adv("GHSA-2", "x")] },
    y: { via: [adv("GHSA-2", "y")] },
  }));
  expect("collect: per package", b.length === 2);

  // An unaccepted advisory is reported; an accepted one is not.
  const r1 = evaluate(a, []);
  expect("evaluate: new advisory fails", r1.unaccepted.length === 1 && r1.stale.length === 0);
  const r2 = evaluate(a, [{ id: "GHSA-1", package: "child" }]);
  expect("evaluate: accepted advisory passes", r2.unaccepted.length === 0 && r2.stale.length === 0);

  // Accepting an advisory for one package does not accept it for another.
  const r3 = evaluate(b, [{ id: "GHSA-2", package: "x" }]);
  expect("evaluate: acceptance is per package", r3.unaccepted.length === 1 && r3.unaccepted[0].package === "y");

  // An accepted entry that is no longer reported is stale.
  const r4 = evaluate([], [{ id: "GHSA-9", package: "gone" }]);
  expect("evaluate: fixed advisory is stale", r4.stale.length === 1);

  // An error answer, or no answer, must throw rather than read as clean.
  for (const [name, input] of [
    ["error object", { error: { code: "ENOAUDIT", summary: "offline" } }],
    ["empty object", {}],
    ["null", null],
  ]) {
    let threw = false;
    try { collectAdvisories(input); } catch { threw = true; }
    expect(`collect: ${name} throws`, threw);
  }

  // A clean report is a clean pass, not an error.
  expect("collect: clean report is empty", collectAdvisories(report({})).length === 0);

  return failures;
}

// ---------------------------------------------------------------------------

function runAudit() {
  // npm audit exits 1 whenever it finds anything, so a non-zero exit is not an
  // error here — the JSON on stdout is the answer either way. A run that
  // produced no parseable JSON is the error.
  let stdout;
  try {
    stdout = execFileSync("npm", ["audit", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    stdout = err && typeof err.stdout === "string" ? err.stdout : "";
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("npm audit did not produce a JSON report (is the registry reachable?)");
  }
}

function main() {
  const testFailures = selfTest();
  if (testFailures.length) {
    console.error("npm audit gate: self-tests FAILED — the checker itself is broken:");
    for (const f of testFailures) console.error(`  - ${f}`);
    process.exit(1);
  }

  let advisories;
  try {
    advisories = collectAdvisories(runAudit());
  } catch (err) {
    console.error(`npm audit gate: could not audit — ${err.message}`);
    console.error("Failing rather than reporting a clean result nobody actually checked.");
    process.exit(1);
  }

  const { unaccepted, stale } = evaluate(advisories, ACCEPTED);

  if (unaccepted.length) {
    console.error(`npm audit gate: ${unaccepted.length} advisory(ies) not fixed and not accepted:\n`);
    for (const a of unaccepted) {
      console.error(`  ${a.severity.padEnd(8)} ${a.package} ${a.range}`);
      console.error(`           ${a.title}`);
      console.error(`           ${a.url || a.id}`);
    }
    console.error(
      "\nFix it (update the package — `npm audit` shows whether a fix is in range), or add an\n" +
        "entry to ACCEPTED in scripts/check-npm-audit.mjs saying why it is not reachable here\n" +
        "and what should make someone look again. Never `npm audit fix --force` blind: its\n" +
        "\"fix\" is sometimes a major downgrade."
    );
  }
  if (stale.length) {
    console.error(`npm audit gate: ${stale.length} ACCEPTED entr(ies) no longer reported — delete them:`);
    for (const a of stale) console.error(`  ${a.id} (${a.package})`);
  }
  if (unaccepted.length || stale.length) process.exit(1);

  console.log(
    `npm audit OK — ${advisories.length} advisory(ies) reported, all accepted with a reason; ` +
      `self-tests passed.`
  );
}

main();
