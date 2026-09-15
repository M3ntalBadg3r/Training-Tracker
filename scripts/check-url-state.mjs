#!/usr/bin/env node
/**
 * check-url-state.mjs — every page that holds a view must be able to restore it.
 *
 * The rule: a client page carrying user-adjustable view state (filters, search,
 * sort, scope, pagination, a projection horizon) mirrors that state to the query
 * string and seeds it back on mount, so leaving the page and pressing Back
 * returns the view instead of the defaults.
 *
 * This exists because the prose version did not hold. Eight report pages
 * established the pattern, and the three pages written afterwards —
 * Compliance Planning, the program dashboard and the offering dashboard — each
 * shipped without it, and each was reported as a bug by the person using it.
 * A convention nothing checks is a convention that applies to whoever remembers
 * it, which is the same lesson `check-route-guards.mjs` was written for.
 *
 * WHAT MAKES A PAGE APPLICABLE — two rules, because neither alone is enough:
 *
 *   1. It lives in a view area (`reports/`, `programs/`, `offerings/`). These
 *      directories hold reports and dashboards by construction, so a new page
 *      in one is in scope before anyone decides anything — which is the point:
 *      a new report inherits the rule rather than being remembered into it.
 *   2. It imports a view-state primitive. Those imports are *behavioural*
 *      evidence that the page has a view to restore, and unlike a naming
 *      convention they cannot be spelled differently.
 *
 * Rule 1 is not redundant. `reports/comparison` carries eight pieces of view
 * state and matches no primitive — it predates `useTableSort` and keeps its own
 * sort logic (CLAUDE.md says so) — so a primitives-only check would have missed
 * the page with the most view state in the codebase. Rule 2 is not redundant
 * either: the dashboard sits outside every view area and is caught only by its
 * `GeoScopeFilter` import.
 *
 * WHAT COUNTS AS COMPLIANT: the page must BOTH call `useSearchParams` (seed the
 * state on mount) AND `router.replace(` (write it back as it changes). Requiring
 * both is load-bearing rather than belt-and-braces. Before it was fixed,
 * `offerings/[offeringName]` called `useSearchParams` to read `?companyId=` — an
 * identifier, not view state — while mirroring nothing, and a check that asked
 * only for `useSearchParams` would have passed the very page whose missing
 * mirror was the reported bug. `admin/offerings/[offeringName]` still has that
 * shape today and is correctly read as not mirroring.
 *
 * TWO LISTS, AND THE DIFFERENCE MATTERS:
 *   EXEMPT     — decided: this page has no view worth restoring. Adding an entry
 *                asserts that, in writing.
 *   KNOWN_GAPS — owed: this page should mirror and does not. Listed so the check
 *                can ship green without pretending the gap is intentional, which
 *                is exactly the "a comment then made the remainder look
 *                intentional" failure CLAUDE.md warns about. The list only ever
 *                shrinks. A NEW page must never be added to it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const APP_ROOT = join(process.cwd(), "src", "app");

/** Directories whose client pages are reports/dashboards by construction. */
const VIEW_AREAS = ["reports", "programs", "offerings"];

/**
 * Importing one of these is evidence the page has user-adjustable view state.
 * Add to this list when a new shared view-state primitive appears; do not
 * replace it with a naming heuristic over `useState` declarations, which flags
 * every modal and loading flag in the codebase.
 */
const VIEW_STATE_PRIMITIVES = [
  ["useTableSort", /\buseTableSort\b/],
  ["Pagination", /\bPagination\b/],
  ["GeoScopeFilter", /\bGeoScopeFilter\b/],
  ["DataTable", /\bDataTable\b/],
  ["useDebounce", /\buseDebounce\b/],
];

const SEEDS_FROM_URL = /\buseSearchParams\s*\(/;
const WRITES_TO_URL = /\brouter\s*\.\s*replace\s*\(/;

/** Decided: no view worth restoring. Each entry is an assertion, so give a reason. */
const EXEMPT = {
  "reports/page.tsx":
    "Report index — a static list of links. No filter, sort or scope exists to restore.",
  "programs/page.tsx":
    "Program index — a card grid of every program. No user-adjustable view state.",
  "offerings/page.tsx":
    "Offering index — a card grid scoped only by the header company switcher, which CompanyScopeProvider already persists to localStorage.",
  "students/[email]/page.tsx":
    "Record detail page. Its DataTable lists one student's own completions, so there is no filtered view to return to; the list it is reached from does its own restore.",
  "admin/specialisations/page.tsx":
    "Admin CRUD list with a name search. Unlike the report pages it has no detail page to open, so there is no navigation away that loses the view — edits happen in a modal.",
};

/**
 * Owed, not approved. These pages should mirror and do not; they predate the
 * check. Fix one and delete its line — never add to this list.
 */
const KNOWN_GAPS = {
  // Empty, and the check keeps it that way: a new page can never be added
  // here, and a listed gap that starts mirroring fails until its line goes.
};

/**
 * Strip comments and string literals so a commented-out or quoted call cannot
 * read as a real one. Deliberately NOT shared with check-route-guards.mjs's
 * richer `stripNonCode`: that one also has to keep brace counting honest for
 * per-handler body extraction, and exporting it would mean refactoring a
 * security check to serve a style check. This does only what presence-matching
 * needs, and STRIP_TESTS keeps it honest.
 */
function stripComments(src) {
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
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** True when the file opts into the client runtime (only those hold view state). */
function isClientComponent(rawSrc) {
  return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(rawSrc);
}

/**
 * The production classifier. SELF_TESTS drives this exact function, so the path
 * under test is the path that runs.
 */
export function classify(relPath, rawSrc) {
  if (!isClientComponent(rawSrc)) {
    return { applicable: false, trigger: null, seeds: false, writes: false };
  }
  const src = stripComments(rawSrc);
  const area = relPath.split("/")[0];

  let trigger = null;
  if (VIEW_AREAS.includes(area)) {
    trigger = `page in the ${area}/ view area`;
  } else {
    for (const [name, pattern] of VIEW_STATE_PRIMITIVES) {
      if (pattern.test(src)) {
        trigger = `uses ${name}`;
        break;
      }
    }
  }

  return {
    applicable: trigger !== null,
    trigger,
    seeds: SEEDS_FROM_URL.test(src),
    writes: WRITES_TO_URL.test(src),
  };
}

// ── Self-tests ────────────────────────────────────────────────────────────
// The checker is the guarantee, so something has to check the checker. These
// assert verdicts, not internals, and run on every invocation.

const MIRRORING = `"use client";
import { useSearchParams, useRouter } from "next/navigation";
export default function P() {
  const searchParams = useSearchParams();
  const router = useRouter();
  router.replace(\`/x?\${qs}\`, { scroll: false });
}`;

const SELF_TESTS = [
  {
    name: "view-area page that mirrors passes",
    path: "reports/thing/page.tsx",
    src: MIRRORING,
    expect: { applicable: true, seeds: true, writes: true },
  },
  {
    name: "view-area page with no URL state at all is applicable and fails",
    path: "reports/thing/page.tsx",
    src: `"use client";\nexport default function P() { const [f, setF] = useState(""); }`,
    expect: { applicable: true, seeds: false, writes: false },
  },
  {
    name: "reads searchParams but never writes back — the identifier-only shape — fails",
    path: "offerings/thing/page.tsx",
    src: `"use client";
import { useSearchParams } from "next/navigation";
export default function P() { const id = useSearchParams().get("companyId"); }`,
    expect: { applicable: true, seeds: true, writes: false },
  },
  {
    name: "page outside a view area is caught by a primitive import",
    path: "dashboard/page.tsx",
    src: `"use client";\nimport GeoScopeFilter from "@/components/reports/GeoScopeFilter";`,
    expect: { applicable: true, trigger: "uses GeoScopeFilter", seeds: false, writes: false },
  },
  {
    name: "view area wins even when no primitive matches (the comparison shape)",
    path: "reports/comparison/page.tsx",
    src: `"use client";\nexport default function P() { const [sortKey, setSortKey] = useState(""); }`,
    expect: { applicable: true, trigger: "page in the reports/ view area", seeds: false, writes: false },
  },
  {
    name: "plain admin page with no primitive is out of scope",
    path: "admin/users/page.tsx",
    src: `"use client";\nexport default function P() { const [open, setOpen] = useState(false); }`,
    expect: { applicable: false },
  },
  {
    name: "server component is out of scope",
    path: "reports/thing/page.tsx",
    src: `export default function P() { return null; }`,
    expect: { applicable: false },
  },
  {
    name: "commented-out mirror does not count as mirroring",
    path: "reports/thing/page.tsx",
    src: `"use client";
import { useSearchParams } from "next/navigation";
const sp = useSearchParams();
// router.replace(url, { scroll: false });`,
    expect: { applicable: true, seeds: true, writes: false },
  },
  {
    name: "mirror named only inside a string does not count",
    path: "reports/thing/page.tsx",
    src: `"use client";
import { useSearchParams } from "next/navigation";
const sp = useSearchParams();
const todo = "router.replace(next)";`,
    expect: { applicable: true, seeds: true, writes: false },
  },
  {
    name: "whitespace in the member call still counts as mirroring",
    path: "reports/thing/page.tsx",
    src: `"use client";
import { useSearchParams } from "next/navigation";
const sp = useSearchParams();
router . replace (next, { scroll: false });`,
    expect: { applicable: true, seeds: true, writes: true },
  },
];

const STRIP_TESTS = [
  { src: `a // b\nc`, want: "a \nc" },
  { src: `a /* b */ c`, want: "a  c" },
  { src: `a "b // c" d`, want: "a  d" },
  { src: "a `b ${x} c` d", want: "a  d" },
  { src: `a "b\\"c" d`, want: "a  d" },
];

function runSelfTests() {
  const failures = [];
  for (const t of SELF_TESTS) {
    const got = classify(t.path, t.src);
    for (const [key, want] of Object.entries(t.expect)) {
      if (got[key] !== want) {
        failures.push(`${t.name}: expected ${key}=${JSON.stringify(want)}, got ${JSON.stringify(got[key])}`);
      }
    }
  }
  for (const t of STRIP_TESTS) {
    const got = stripComments(t.src);
    if (got !== t.want) {
      failures.push(`stripComments(${JSON.stringify(t.src)}) => ${JSON.stringify(got)}, want ${JSON.stringify(t.want)}`);
    }
  }
  if (failures.length > 0) {
    console.error("check-url-state: SELF-TESTS FAILED — the checker itself is broken.\n");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  return SELF_TESTS.length + STRIP_TESTS.length;
}

// ── Scan ──────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

const selfTestCount = runSelfTests();

const inventory = process.argv.includes("--inventory");
const violations = [];
const gaps = [];
const stale = [];
const rows = [];
let mirrored = 0;

const seen = new Set();
for (const file of walk(APP_ROOT).sort()) {
  const rel = relative(APP_ROOT, file).split(sep).join("/");
  seen.add(rel);
  const { applicable, trigger, seeds, writes } = classify(rel, readFileSync(file, "utf8"));
  if (!applicable) continue;

  const compliant = seeds && writes;
  let verdict;
  if (compliant) {
    verdict = "mirrors";
    mirrored++;
  } else if (rel in EXEMPT) {
    verdict = "exempt";
  } else if (rel in KNOWN_GAPS) {
    verdict = "known gap";
    gaps.push(rel);
  } else {
    verdict = "MISSING";
    violations.push({ rel, trigger, seeds, writes });
  }
  rows.push({ rel, trigger, verdict });
}

// An entry that no longer describes a real page is worse than no entry: it is a
// decision nobody can see is dead. The same applies to a gap that was fixed but
// left listed, which would quietly re-permit a regression.
for (const rel of Object.keys(EXEMPT)) {
  if (!seen.has(rel)) stale.push(`EXEMPT names ${rel}, which no longer exists`);
}
for (const rel of Object.keys(KNOWN_GAPS)) {
  if (!seen.has(rel)) stale.push(`KNOWN_GAPS names ${rel}, which no longer exists`);
  else if (!gaps.includes(rel)) stale.push(`KNOWN_GAPS names ${rel}, which now mirrors — delete the line`);
}

if (inventory) {
  const width = Math.max(...rows.map((r) => r.rel.length));
  for (const r of rows) console.log(`${r.rel.padEnd(width)}  ${r.verdict.padEnd(10)}  ${r.trigger}`);
  console.log("");
}

for (const v of violations) {
  console.error(`✗ ${v.rel} — ${v.trigger}, but does not restore its view.`);
  if (!v.seeds) console.error("    missing: seed state from useSearchParams() on mount");
  if (!v.writes) console.error("    missing: mirror state back with router.replace(…, { scroll: false })");
}
for (const s of stale) console.error(`✗ ${s}`);

if (violations.length > 0 || stale.length > 0) {
  console.error(
    "\nA page holding filters, search, sort, scope or pagination must mirror them to" +
      "\nthe URL and seed them back on mount, so Back from a record restores the view." +
      "\nSee CLAUDE.md → 'View state belongs in the URL' for the pattern to copy." +
      "\nIf the page genuinely has no view worth restoring, add it to EXEMPT in" +
      `\n${relative(process.cwd(), new URL(import.meta.url).pathname)} with the reason.`
  );
  process.exit(1);
}

const gapNote = gaps.length > 0 ? `; ${gaps.length} known gap${gaps.length === 1 ? "" : "s"} outstanding` : "";
console.log(
  `URL state OK — ${mirrored} of ${rows.length} view pages mirror, ` +
    `${Object.keys(EXEMPT).length} exempt${gapNote}; ${selfTestCount} scanner self-tests passed.`
);
if (gaps.length > 0) {
  console.log("Outstanding (predate this check; the list only shrinks):");
  for (const rel of gaps) console.log(`  - ${rel}: ${KNOWN_GAPS[rel]}`);
}
