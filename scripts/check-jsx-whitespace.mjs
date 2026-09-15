#!/usr/bin/env node
/**
 * JSX line-break whitespace scan — catches prose that renders with two words
 * glued together because a line break swallowed the space between them.
 *
 * ## The rule this enforces
 *
 * JSX removes whitespace that is adjacent to a tag and contains a newline. So
 * this, which looks correct in the editor:
 *
 *     Click <strong>View</strong>
 *     on any row to open the record
 *
 * compiles to ["Click ", <strong>View</strong>, "on any row to open the record"]
 * and renders "Click Viewon any row". The same text with the break elsewhere,
 * or with the space written explicitly as {" "}, renders correctly:
 *
 *     Click <strong>View</strong>{" "}
 *     on any row to open the record
 *
 * That is why `src/lib/help-content.tsx` is written with {" "} at inline-tag
 * boundaries throughout, and why those markers must not be "tidied" back into
 * plain spaces.
 *
 * ## What this scan does NOT key on, and the history behind that
 *
 * It does not look at HTML entities, and it is not SWC-specific. Both of those
 * were in the previous account of this bug and both are wrong; the scan that
 * was built on them reported only false positives.
 *
 * The record, because it cost real time twice: v2.83 found 34 genuinely glued
 * spots by scanning with TypeScript's JSX semantics and fixed them. A follow-up
 * then concluded that the real trigger was SWC dropping the leading whitespace
 * of any text run containing an entity — including a plain same-line space —
 * and that "tsc and Babel do not reproduce it". Running the four cases through
 * Next's own SWC binding and through tsc refutes every part of that:
 *
 *     newline + entity      -> space removed    (both compilers)
 *     newline, no entity    -> space removed    (both compilers)
 *     same-line + entity    -> space kept       (both compilers)
 *     same-line, no entity  -> space kept       (both compilers)
 *
 * Entities make no difference, and the two compilers agree exactly. The only
 * thing that matters is whether the whitespace contains a newline — ordinary,
 * documented JSX behaviour, which is precisely why {" "} exists as an idiom.
 * v2.83's original diagnosis was right.
 *
 * ## Scope
 *
 * Only a break immediately after a closing *inline* tag is flagged, and only
 * when the next line starts with a word character. A block-level tag ends a
 * line legitimately, and a run starting with punctuation (a comma pushed onto
 * the next line to avoid a space before it) wants no space anyway.
 *
 * There is no escape-hatch env var, unlike the PR-gated checks: a finding here
 * always has a correct in-source fix — add {" "} at the break, or move the
 * break — so there is never a reason to need to override it.
 */

import fs from "node:fs";
import path from "node:path";

/** Tags that sit inside a sentence, where a lost space is visible. */
const INLINE_TAGS = ["strong", "em", "b", "i", "u", "code", "a", "span", "small", "abbr", "Link"];

/**
 * Blank out comments so prose inside a JSDoc block can't look like markup.
 * Replaces with spaces rather than deleting, so reported line numbers stay true.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let j = i; j < stop; j++) out += src[j] === "\n" ? "\n" : " ";
      i = stop;
    } else if (two === "//") {
      let stop = src.indexOf("\n", i);
      if (stop === -1) stop = src.length;
      out += " ".repeat(stop - i);
      i = stop;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

const PATTERN = new RegExp(
  `</(?:${INLINE_TAGS.join("|")})>([ \\t]*\\r?\\n[ \\t]*)([A-Za-z0-9][^<{\\n]{0,70})`,
  "g",
);

/**
 * @returns {{index:number, tag:string, text:string}[]} one entry per glued run.
 */
export function findGluedRuns(source) {
  const src = stripComments(source);
  const found = [];
  let m;
  PATTERN.lastIndex = 0;
  while ((m = PATTERN.exec(src))) {
    found.push({ index: m.index, tag: m[0].slice(0, m[0].indexOf(">") + 1), text: m[2] });
  }
  return found;
}

const SELF_TESTS = [
  // The bug itself — and the same thing without an entity, to pin down that
  // entities are irrelevant.
  ["<p>Click <strong>View</strong>\n  on any row &mdash; go</p>", 1, "break after inline tag, entity"],
  ["<p>Click <strong>View</strong>\n  on any row - go</p>", 1, "break after inline tag, no entity"],
  ["<p>a <code>x</code>\n  b</p>", 1, "code tag"],
  ["<p>a <Link href=\"/x\">y</Link>\n  b</p>", 1, "component tag"],

  // Correct forms that must never be flagged.
  ["<p>Click <strong>View</strong>{\" \"}\n  on any row &mdash; go</p>", 0, "explicit {\" \"} before the break"],
  ["<p>Click <strong>View</strong>\n  {\" \"}on any row</p>", 0, "explicit {\" \"} after the break"],
  ["<p>Click <strong>View</strong> on any row &mdash; go</p>", 0, "same-line space, entity"],
  ["<p>Click <strong>View</strong> on any row - go</p>", 0, "same-line space, no entity"],
  ["<p>Deletes <strong>everything</strong>\n  , and returns it</p>", 0, "break before punctuation wants no space"],
  ["<div>\n  <strong>x</strong>\n</div>", 0, "break before a tag, not text"],
  ["<div>text</div>\n  more text", 0, "block-level tag"],

  // Prose in a comment must not be mistaken for markup.
  ["/* Click <strong>View</strong>\n   on any row */", 0, "inside a block comment"],
  ["// <strong>x</strong>\nconst a = 1;", 0, "inside a line comment"],
];

function runSelfTests() {
  const failures = [];
  for (const [src, expected, name] of SELF_TESTS) {
    const got = findGluedRuns(src).length;
    if (got !== expected) failures.push(`  ${name}: expected ${expected}, got ${got}`);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} self-test failure(s) in this script:\n`);
    console.error(failures.join("\n"));
    process.exit(1);
  }
  return SELF_TESTS.length;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx|jsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const selfTestCount = runSelfTests();

const findings = [];
for (const file of walk("src")) {
  const source = fs.readFileSync(file, "utf8");
  for (const hit of findGluedRuns(source)) {
    const line = source.slice(0, hit.index).split("\n").length;
    findings.push({ file, line, tag: hit.tag, text: hit.text });
  }
}

if (findings.length > 0) {
  console.error(
    `\n${findings.length} place(s) where a line break will swallow the space ` +
      `and render two words glued together:\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    after ${f.tag} the next line starts "${f.text.trim().slice(0, 60)}"`);
  }
  console.error(
    `\nFix by writing the space explicitly — put {" "} at the break — or by ` +
      `moving the line break.\n`,
  );
  process.exit(1);
}

console.log(`JSX line-break whitespace OK (${selfTestCount} self-tests passed).`);
