#!/usr/bin/env node
/**
 * check-api-spec — every public-API endpoint is described, and every query
 * parameter it actually reads is documented.
 *
 * ## Why this exists
 *
 * The public API's only documentation used to be a hand-maintained `endpoints`
 * array in `src/app/api/public/v1/route.ts`, with nothing tying it to the code.
 * It drifted exactly as you would expect: `training-records` was described as
 * "Per-completion training records" while the route had grown four filters
 * (`theatre`, `region`, `country`, `activeOnly`) that no reader could discover.
 * A partner integration reads that list and the OpenAPI document generated
 * beside it; a parameter missing from both is a parameter nobody outside this
 * repository knows exists.
 *
 * So the index, the OpenAPI document and this check all read one module —
 * `src/lib/public-api-spec.ts` — and this script asserts that module still
 * describes the code.
 *
 * ## What it asserts
 *
 * 1. Every `route.ts` under `src/app/api/public/v1/` has exactly one spec entry,
 *    and every spec entry names a route file that exists. A new endpoint cannot
 *    ship undocumented, and a deleted one cannot linger in the docs.
 * 2. Every query parameter an endpoint's code reads is documented. This is the
 *    direction that actually bit us.
 * 3. Every documented parameter is really read somewhere — unless it is marked
 *    `source: "guard"`, which is how `companyId` is described: it is consumed by
 *    `authorizePublicRequest`, never by the handler. This catches the reverse
 *    drift, a parameter documented after the code stopped reading it.
 * 4. The committed `docs/openapi.json` matches what the module generates, so the
 *    copy a partner reads on GitHub cannot fall behind the running API.
 *
 * ## Two things about the implementation
 *
 * **Parameter parsing is not always in the route file.** `programs/planning`
 * reads only `options` itself; `targets`, `level`, `country`, `region`,
 * `theatre`, `renewalWindowMonths` and `planForWindow` are all parsed by
 * `parsePlanRequest` in `src/lib/compliance-plan-request.ts`, which the internal
 * route shares. A scan of route files alone would report a clean pass on the
 * endpoint with the most parameters, so each spec entry lists the files that
 * carry its parsing in `paramSources`.
 *
 * **This scanner strips comments but KEEPS string literals**, which is the
 * opposite of `check-url-state.mjs`'s stripper. That one is matching for the
 * presence of a call and so discards strings wholesale; this one has to read the
 * literal out of `searchParams.get("theatre")`. Sharing either implementation
 * would break the other, and STRIP_TESTS below pins the difference.
 *
 * Usage:
 *   node scripts/check-api-spec.mjs              # check; non-zero on a gap
 *   node scripts/check-api-spec.mjs --inventory  # print the full table
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// See scripts/generate-openapi.mjs for why this is filtered on `code` rather
// than with `--no-warnings=…`, which ignores its value and hides every warning.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w.name}: ${w.message}`);
});

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_API_DIR = join(ROOT, "src/app/api/public/v1");
const COMMITTED_SPEC = join(ROOT, "docs/openapi.json");

/**
 * Remove comments, keep string literals intact.
 *
 * A commented-out `searchParams.get("legacy")` must not read as a live
 * parameter, but the quoted name inside a real call is the whole point of the
 * scan — so unlike the other scanners' strippers, strings survive this pass.
 * An unterminated literal (which cannot compile anyway) ends the scan rather
 * than looping.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== "*/") i++;
      i += 2;
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\" && i + 1 < src.length) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < src.length) out += src[i];
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The query-parameter names a source file reads.
 *
 * Keyed on `.get("…")` rather than on a receiver name: the ten routes reach the
 * params object through four different identifiers (`searchParams`, `params`,
 * `sp`, `p`), and a receiver-name matcher would silently miss whichever one a
 * new route happened to pick.
 */
export function readParamNames(rawSrc) {
  const src = stripComments(rawSrc);
  const names = new Set();
  for (const m of src.matchAll(/\.get\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g)) {
    names.add(m[1]);
  }
  return names;
}

/** Every `route.ts` under the public API, as paths relative to that directory. */
function discoverRouteFiles(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...discoverRouteFiles(full, prefix ? `${prefix}/${entry}` : entry));
    } else if (entry === "route.ts") {
      found.push(prefix ? `${prefix}/route.ts` : "route.ts");
    }
  }
  return found;
}

// ─── Self-tests ──────────────────────────────────────────────────────────────
// The checker is the guarantee, so something has to check the checker. These
// drive the same exported functions the real scan uses.

const STRIP_TESTS = [
  {
    name: "a commented-out read is not a parameter",
    src: '// const x = sp.get("legacy");\nconst y = sp.get("theatre");',
    expect: ["theatre"],
  },
  {
    name: "a block-commented read is not a parameter",
    src: '/* sp.get("legacy") */ const y = sp.get("theatre");',
    expect: ["theatre"],
  },
  {
    name: "string literals survive the strip (the whole point)",
    src: 'const y = searchParams.get("activeOnly");',
    expect: ["activeOnly"],
  },
  {
    name: "every receiver name is matched, not just searchParams",
    src: 'a.get("one"); sp.get("two"); p.get("three"); params.get("four");',
    expect: ["four", "one", "three", "two"],
  },
  {
    name: "single and back quotes count too",
    src: "sp.get('one'); sp.get(`two`);",
    expect: ["one", "two"],
  },
  {
    name: "an apostrophe inside a comment does not swallow the next read",
    src: '// it\'s fine\nconst y = sp.get("theatre");',
    expect: ["theatre"],
  },
  {
    name: "a url in a comment is not read as a block comment opener",
    src: '// see https://example.com/a/*b\nconst y = sp.get("theatre");',
    expect: ["theatre"],
  },
  {
    name: "an unterminated literal terminates rather than hanging",
    src: 'const y = sp.get("theatre"); const bad = "oops',
    expect: ["theatre"],
  },
];

function runSelfTests() {
  const failures = [];
  for (const t of STRIP_TESTS) {
    const got = [...readParamNames(t.src)].sort();
    const want = [...t.expect].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`  ✗ ${t.name}\n      expected [${want}] but got [${got}]`);
    }
  }
  if (failures.length > 0) {
    console.error("Scanner self-tests FAILED — the checker itself is broken:\n" + failures.join("\n"));
    process.exit(1);
  }
  return STRIP_TESTS.length;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const selfTestCount = runSelfTests();
const inventory = process.argv.includes("--inventory");

// Node 22 strips TypeScript types natively (verified on 22.22; every CI job pins
// `node-version: 22`). The spec module has zero imports for exactly this reason
// — no path aliases to resolve — matching the lib/csp.ts and lib/roles.ts
// precedent. A failure here is loud rather than silent.
let spec;
try {
  spec = await import(join(ROOT, "src/lib/public-api-spec.ts"));
} catch (err) {
  console.error(
    "Could not load src/lib/public-api-spec.ts.\n" +
      "This script imports it directly, which needs a Node with TypeScript type\n" +
      "stripping (22.18+). Keep that module import-free — a path alias cannot be\n" +
      `resolved by the stripper.\n\n${err?.message ?? err}`
  );
  process.exit(1);
}

const endpoints = spec.PUBLIC_API_ENDPOINTS;
const problems = [];
const rows = [];

const onDisk = new Set(discoverRouteFiles(PUBLIC_API_DIR));
const described = new Set();

for (const ep of endpoints) {
  if (described.has(ep.routeFile)) {
    problems.push(`two spec entries claim ${ep.routeFile}`);
    continue;
  }
  described.add(ep.routeFile);

  if (!onDisk.has(ep.routeFile)) {
    problems.push(`spec describes ${ep.path}, but ${ep.routeFile} does not exist`);
    continue;
  }

  // The endpoint's own file, plus any module its parsing was lifted into.
  const sources = [join(PUBLIC_API_DIR, ep.routeFile), ...(ep.paramSources ?? []).map((p) => join(ROOT, p))];
  const read = new Set();
  for (const file of sources) {
    for (const name of readParamNames(readFileSync(file, "utf8"))) read.add(name);
  }

  const documented = new Map((ep.parameters ?? []).map((p) => [p.name, p]));

  for (const name of [...read].sort()) {
    if (!documented.has(name)) {
      problems.push(`${ep.path} reads ?${name}= but the spec does not document it`);
    }
  }
  for (const [name, p] of documented) {
    if (p.in === "path" || p.source === "guard") continue;
    if (!read.has(name)) {
      problems.push(`${ep.path} documents ?${name}= but no source reads it — stale entry?`);
    }
  }

  rows.push({ path: ep.path, params: documented.size, read: read.size });
}

for (const file of [...onDisk].sort()) {
  if (!described.has(file)) {
    problems.push(`${file} is a public endpoint with no entry in public-api-spec.ts`);
  }
}

// The committed copy is what a partner reads before they hold a key, so a stale
// one is worse than none: it describes an API that is not the one running.
try {
  const committed = readFileSync(COMMITTED_SPEC, "utf8");
  const generated = JSON.stringify(spec.buildOpenApiDocument(), null, 2) + "\n";
  if (committed !== generated) {
    problems.push(`docs/openapi.json is out of date — run \`npm run openapi:generate\``);
  }
} catch {
  problems.push(`docs/openapi.json is missing — run \`npm run openapi:generate\``);
}

if (inventory) {
  const width = Math.max(...rows.map((r) => r.path.length));
  for (const r of rows) {
    console.log(`${r.path.padEnd(width)}  ${String(r.params).padStart(2)} documented  ${String(r.read).padStart(2)} read in code`);
  }
  console.log("");
}

if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(
    "\nThe public API documents itself from src/lib/public-api-spec.ts — the index" +
      "\nendpoint, docs/openapi.json and this check all read it. Add or correct the" +
      "\nentry there rather than editing the index array or the generated file." +
      "\nIf an endpoint's parameters are parsed in a shared module, list that module" +
      "\nin the entry's `paramSources` or this check cannot see them."
  );
  process.exit(1);
}

console.log(
  `API spec OK — ${rows.length} public endpoints described, ` +
    `${rows.reduce((n, r) => n + r.params, 0)} parameters documented; ` +
    `${selfTestCount} scanner self-tests passed.`
);
