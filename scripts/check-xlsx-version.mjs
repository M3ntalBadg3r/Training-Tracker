#!/usr/bin/env node
/**
 * xlsx version watch — the one dependency `npm audit` cannot see.
 *
 * ## Why this exists
 *
 * `xlsx` (SheetJS) is installed from the vendor's CDN, not the npm registry:
 * the registry copy is frozen at 0.18.5 with two unfixed advisories, because
 * SheetJS stopped publishing there (see the Deployment section of CLAUDE.md).
 * The price is that `npm audit` has no advisory data for a tarball URL, so
 * `scripts/check-npm-audit.mjs` — the gate that notices every other advisory —
 * says nothing about this package, and nothing else would notice a new SheetJS
 * release or a new SheetJS advisory either. This is that noticing, run from the
 * same workflow and on the same weekly schedule as the audit.
 *
 * ## What it asserts
 *
 * Locally (no network):
 *   1. package.json and package-lock.json both pin xlsx to the vendor's CDN
 *      tarball for ONE version, and the lockfile carries an integrity hash. A
 *      drift back to the registry (`"xlsx": "^0.18.5"`, which `npm install xlsx`
 *      would write) reintroduces both advisories without any check noticing.
 *   2. The pinned version is at or above the fixed-in version of every advisory
 *      in KNOWN_ADVISORIES.
 *
 * Against the vendor (cdn.sheetjs.com):
 *   3. The newest release is the pinned one. A newer release fails — bump the
 *      pin, or add a DEFERRED entry saying why not and what should make someone
 *      look again. A DEFERRED entry that no longer describes the situation (the
 *      pin caught up, or an even newer release appeared) fails too: the list
 *      only shrinks by someone noticing, and this is the noticing.
 *   4. Every advisory on the vendor's advisory page is in KNOWN_ADVISORIES. A
 *      new one fails: read it, record its fixed-in version, and bump if needed.
 *   5. A run that could not ask fails. An unreachable CDN, a challenge page, or
 *      a page with no advisory ids on it must never read as "nothing new".
 *
 * Run: npm run check:xlsx
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compareVersions, parseVersion } from "../deploy/lib/version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CDN = "https://cdn.sheetjs.com";
const LATEST_URL = `${CDN}/xlsx-latest/package/package.json`;
const ADVISORIES_URL = `${CDN}/advisories/`;

/**
 * Every advisory the vendor has published for SheetJS CE, with the first
 * release that fixes it. Taken from the advisory pages themselves
 * (cdn.sheetjs.com/advisories/<id>), not from memory.
 */
const KNOWN_ADVISORIES = [
  { id: "CVE-2023-30533", title: "Prototype pollution when reading crafted files", fixedIn: "0.19.3" },
  { id: "CVE-2024-22363", title: "Regular expression denial of service (ReDoS)", fixedIn: "0.20.2" },
];

/**
 * A newer release we have decided not to take yet, with the reason. Empty is
 * the normal state. Shape: { version, reason, recheck }.
 */
const DEFERRED = [];

/** The CDN tarball URL for a version — the only form the pin may take. */
export function cdnTarball(version) {
  return `${CDN}/xlsx-${version}/xlsx-${version}.tgz`;
}

/** Problems with how xlsx is pinned, from package.json and package-lock.json. */
export function checkPin(pkg, lock) {
  const problems = [];
  const spec = pkg?.dependencies?.xlsx;
  const match = typeof spec === "string" ? spec.match(/^https:\/\/cdn\.sheetjs\.com\/xlsx-([0-9][0-9A-Za-z.-]*)\/xlsx-\1\.tgz$/) : null;
  if (!match) {
    problems.push(
      `package.json pins xlsx to ${JSON.stringify(spec)}, not a cdn.sheetjs.com tarball. ` +
        "The npm registry copy is frozen at 0.18.5 with two unfixed advisories."
    );
    return { version: null, problems };
  }
  const version = match[1];
  if (!parseVersion(version)) problems.push(`package.json pins xlsx to an unreadable version "${version}".`);

  const entry = lock?.packages?.["node_modules/xlsx"];
  if (!entry) {
    problems.push("package-lock.json has no node_modules/xlsx entry.");
  } else {
    if (entry.version !== version) {
      problems.push(`package-lock.json has xlsx ${entry.version}, package.json pins ${version}.`);
    }
    if (entry.resolved !== cdnTarball(version)) {
      problems.push(`package-lock.json resolves xlsx from ${entry.resolved}, expected ${cdnTarball(version)}.`);
    }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      problems.push("package-lock.json carries no sha512 integrity hash for xlsx.");
    }
  }
  return { version, problems };
}

/** Advisories in `known` whose fix the pinned version does not include. */
export function unfixedKnown(version, known) {
  return known.filter((a) => compareVersions(version, a.fixedIn) < 0);
}

/** Advisory ids on the vendor's advisory page. Throws when there are none. */
export function parseAdvisoryIds(html) {
  const ids = [...new Set(String(html).match(/\bCVE-\d{4}-\d{4,}\b/g) || [])].sort();
  if (ids.length === 0) {
    throw new Error("the advisory page lists no advisory ids (page changed, or a challenge page was served)");
  }
  return ids;
}

/** The version in the vendor's xlsx-latest package.json. Throws when unreadable. */
export function parseLatestVersion(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("xlsx-latest/package.json is not JSON (a challenge page was served?)");
  }
  if (json?.name !== "xlsx" || typeof json.version !== "string" || !parseVersion(json.version)) {
    throw new Error("xlsx-latest/package.json does not name an xlsx version");
  }
  return json.version;
}

/** Decide what the vendor's answers mean for the pinned version. */
export function evaluate({ pinned, latest, advisoryIds, known, deferred }) {
  const problems = [];
  const notes = [];

  const newer = compareVersions(latest, pinned) > 0;
  const deferral = deferred.find((d) => d.version === latest);
  if (newer && !deferral) {
    problems.push(
      `SheetJS ${latest} is available; ${pinned} is pinned. Bump the pin (package.json + ` +
        "`npm install`, then check the lockfile still resolves from cdn.sheetjs.com), or add a " +
        "DEFERRED entry in scripts/check-xlsx-version.mjs saying why not."
    );
  }
  for (const d of deferred) {
    if (!newer || d.version !== latest) {
      problems.push(
        `DEFERRED entry for ${d.version} no longer applies (pinned ${pinned}, latest ${latest}) — ` +
          "delete it, or replace it with one for the current release."
      );
    }
  }

  const knownIds = new Set(known.map((a) => a.id));
  for (const id of advisoryIds) {
    if (!knownIds.has(id)) {
      problems.push(
        `SheetJS has published ${id}, which is not in KNOWN_ADVISORIES. Read ${CDN}/advisories/${id}, ` +
          "add it with the version that fixes it, and bump the pin if that version is newer."
      );
    }
  }
  const listed = new Set(advisoryIds);
  for (const a of known) {
    if (!listed.has(a.id)) notes.push(`${a.id} is no longer on the vendor's advisory page.`);
  }
  return { problems, notes };
}

// ---------------------------------------------------------------------------
// Self-tests — run on every invocation, like the other scripts/check-*.mjs.
// ---------------------------------------------------------------------------

function selfTest() {
  const failures = [];
  const expect = (name, ok) => { if (!ok) failures.push(name); };
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  // A fixture, not the real list, so that editing KNOWN_ADVISORIES reaches the
  // live check below instead of tripping a self-test.
  const FIXTURE_KNOWN = [
    { id: "CVE-2023-30533", title: "a", fixedIn: "0.19.3" },
    { id: "CVE-2024-22363", title: "b", fixedIn: "0.20.2" },
  ];

  const url = cdnTarball("0.20.3");
  const lockOf = (version, resolved, integrity = "sha512-abc") => ({
    packages: { "node_modules/xlsx": { version, resolved, integrity } },
  });

  const ok = checkPin({ dependencies: { xlsx: url } }, lockOf("0.20.3", url));
  expect("pin: CDN tarball accepted", ok.version === "0.20.3" && ok.problems.length === 0);
  expect("pin: registry range refused", checkPin({ dependencies: { xlsx: "^0.18.5" } }, lockOf("0.18.5", url)).problems.length === 1);
  expect("pin: missing dependency refused", checkPin({ dependencies: {} }, lockOf("0.20.3", url)).problems.length === 1);
  expect(
    "pin: mismatched versions in the URL refused",
    checkPin({ dependencies: { xlsx: `${CDN}/xlsx-0.20.3/xlsx-0.20.2.tgz` } }, lockOf("0.20.3", url)).version === null
  );
  expect(
    "pin: lockfile on another version refused",
    checkPin({ dependencies: { xlsx: url } }, lockOf("0.20.2", cdnTarball("0.20.2"))).problems.length === 2
  );
  expect(
    "pin: lockfile resolving from the registry refused",
    checkPin({ dependencies: { xlsx: url } }, lockOf("0.20.3", "https://registry.npmjs.org/xlsx/-/xlsx-0.20.3.tgz")).problems.length === 1
  );
  expect("pin: missing integrity refused", checkPin({ dependencies: { xlsx: url } }, lockOf("0.20.3", url, "")).problems.length === 1);

  expect("known: fixed version passes", unfixedKnown("0.20.2", FIXTURE_KNOWN).length === 0);
  expect("known: older version fails", unfixedKnown("0.20.1", FIXTURE_KNOWN).map((a) => a.id).join() === "CVE-2024-22363");

  expect("ids: found and de-duplicated", parseAdvisoryIds('<a href="CVE-2024-22363.html">CVE-2024-22363</a> CVE-2023-30533').join() === "CVE-2023-30533,CVE-2024-22363");
  expect("ids: an empty page throws", throws(() => parseAdvisoryIds("<html>Just a moment...</html>")));
  expect("latest: read", parseLatestVersion('{"name":"xlsx","version":"0.20.4"}') === "0.20.4");
  expect("latest: HTML throws", throws(() => parseLatestVersion("<!DOCTYPE html>")));
  expect("latest: other package throws", throws(() => parseLatestVersion('{"name":"other","version":"1.0.0"}')));

  const base = { pinned: "0.20.3", latest: "0.20.3", advisoryIds: FIXTURE_KNOWN.map((a) => a.id), known: FIXTURE_KNOWN, deferred: [] };
  expect("evaluate: up to date passes", evaluate(base).problems.length === 0);
  expect("evaluate: newer release fails", evaluate({ ...base, latest: "0.20.4" }).problems.length === 1);
  expect(
    "evaluate: deferred release passes",
    evaluate({ ...base, latest: "0.20.4", deferred: [{ version: "0.20.4" }] }).problems.length === 0
  );
  expect(
    "evaluate: deferral for an older release is stale",
    evaluate({ ...base, latest: "0.20.5", deferred: [{ version: "0.20.4" }] }).problems.length === 2
  );
  expect("evaluate: deferral once caught up is stale", evaluate({ ...base, deferred: [{ version: "0.20.3" }] }).problems.length === 1);
  expect("evaluate: new advisory fails", evaluate({ ...base, advisoryIds: [...base.advisoryIds, "CVE-2026-00001"] }).problems.length === 1);
  const gone = evaluate({ ...base, advisoryIds: ["CVE-2024-22363"] });
  expect("evaluate: a vanished advisory is a note, not a failure", gone.problems.length === 0 && gone.notes.length === 1);

  for (const a of KNOWN_ADVISORIES) expect(`known: ${a.id} has a readable fixedIn`, !!parseVersion(a.fixedIn));
  return failures;
}

// ---------------------------------------------------------------------------

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const testFailures = selfTest();
  if (testFailures.length) {
    console.error("xlsx watch: self-tests FAILED — the checker itself is broken:");
    for (const f of testFailures) console.error(`  - ${f}`);
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const { version: pinned, problems } = checkPin(pkg, lock);
  if (pinned) {
    for (const a of unfixedKnown(pinned, KNOWN_ADVISORIES)) {
      problems.push(`pinned xlsx ${pinned} is affected by ${a.id} (${a.title}); fixed in ${a.fixedIn}.`);
    }
  }
  if (problems.length || !pinned) {
    console.error("xlsx watch: the pin is wrong:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  let latest;
  let advisoryIds;
  try {
    [latest, advisoryIds] = await Promise.all([
      fetchText(LATEST_URL).then(parseLatestVersion),
      fetchText(ADVISORIES_URL).then(parseAdvisoryIds),
    ]);
  } catch (err) {
    console.error(`xlsx watch: could not ask the vendor — ${err.message}`);
    console.error("Failing rather than reporting a clean result nobody actually checked.");
    process.exit(1);
  }

  const result = evaluate({ pinned, latest, advisoryIds, known: KNOWN_ADVISORIES, deferred: DEFERRED });
  for (const n of result.notes) console.log(`xlsx watch: note — ${n}`);
  if (result.problems.length) {
    console.error("xlsx watch:");
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const state =
    compareVersions(latest, pinned) > 0
      ? `pinned ${pinned}, newest ${latest} deferred with a reason`
      : `pinned ${pinned} is the newest SheetJS release`;
  console.log(
    `xlsx watch OK — ${state}; ${advisoryIds.length} vendor advisory(ies), all fixed in the pin; ` +
      "self-tests passed."
  );
}

await main();
