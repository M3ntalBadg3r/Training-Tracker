#!/usr/bin/env node
/**
 * generate-openapi — write docs/openapi.json from src/lib/public-api-spec.ts.
 *
 * The committed file is what a partner reads before they hold a key, so it has
 * to exist somewhere they can see without authenticating. It lives in `docs/`
 * and NOT in `public/`: anything under `public/` is served by Next at
 * `/openapi.json`, which would quietly create an unauthenticated copy of the
 * API surface. The served copy is key-gated at /api/public/v1/openapi.json.
 *
 * `npm run check:api-spec` regenerates and diffs, so a stale committed file
 * fails CI rather than sitting there describing an API that no longer exists.
 *
 * This imports the `.ts` module directly, which works because Node strips
 * TypeScript types natively (22.18+; verified on 22.22, and every CI job pins
 * `node-version: 22`). Stripping is not compiling — there is no path-alias
 * resolution — which is why that module imports nothing.
 *
 * Usage: node scripts/generate-openapi.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Importing a .ts file from a package with no "type" field makes Node print a
// MODULE_TYPELESS_PACKAGE_JSON warning — four lines, on every healthy run, in
// CI. That is how a log stops being read, so it is filtered here.
//
// Filtered on `code` and NOT with `--no-warnings=MODULE_TYPELESS_PACKAGE_JSON`:
// measured on Node 22.22, that flag ignores its value and suppresses *every*
// warning, which would hide real ones. Matching the code drops this one and
// leaves the rest printing. (`name` is "Warning" for both, so it cannot be the
// discriminator.) Adding `"type": "module"` to package.json would also fix it,
// and would change module resolution for the whole project to fix a log line.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w.name}: ${w.message}`);
});

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "docs/openapi.json");

let spec;
try {
  spec = await import(join(ROOT, "src/lib/public-api-spec.ts"));
} catch (err) {
  console.error(
    "Could not load src/lib/public-api-spec.ts.\n" +
      "This script imports it directly, which needs a Node with TypeScript type\n" +
      "stripping (22.18+). Keep that module import-free — the stripper cannot\n" +
      `resolve a path alias.\n\n${err?.message ?? err}`
  );
  process.exit(1);
}

const document = spec.buildOpenApiDocument();

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(document, null, 2) + "\n");

const paths = Object.keys(document.paths).length;
console.log(`Wrote docs/openapi.json — ${paths} endpoints, OpenAPI ${document.openapi}.`);
