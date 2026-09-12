#!/usr/bin/env node
/**
 * Route guard check — the standing enforcement of Round 1 item 3.
 *
 * Every exported HTTP handler under `src/app/api/**` must either call one of the
 * recognised auth guards, or appear in PUBLIC_HANDLERS below with a reason.
 *
 * ## Why this exists
 *
 * "Add requireAuth() to every handler" was completed once, in April, and then
 * decayed: it is a per-route obligation that every new handler inherits, but
 * nothing carried it forward, so handlers written afterwards were never held to
 * it. A reflected-XSS finding and an auth bypass both traced back to a handler
 * that simply never got a guard, and in the XSS case the route was *implicitly*
 * public — nobody had decided that, it just was.
 *
 * PUBLIC_HANDLERS turns that silent omission into a line of code someone has to
 * write and a reviewer can see.
 *
 * ## Why the check is per handler, not per file
 *
 * `GET /api/training-data/[title]` was unguarded while its PUT/PATCH/DELETE
 * siblings in the same file all called requireSuperAdmin. A per-file check would
 * have passed that file and missed a live auth hole, so each exported handler is
 * inspected on its own.
 *
 * Usage:
 *   node scripts/check-route-guards.mjs              # check; non-zero on a gap
 *   node scripts/check-route-guards.mjs --inventory  # print the full table
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const API_ROOT = join(process.cwd(), "src", "app", "api");

/**
 * Calls that count as authenticating a request.
 *
 * `ensurePublicApiEnabled` is deliberately NOT on this list, and the omission is
 * the point. It is the global public-API on/off switch — it answers "is this
 * surface turned on", never "who is calling" — but it used to be accepted here
 * because the `/api/public/v1` index route calls it directly instead of going
 * through `authorizePublicRequest`. That reasoning was wrong twice over: the
 * index route also calls `requireApiKey`, so it never needed the allowance, and
 * while it stood, any new public handler could satisfy this check with the
 * switch alone and ship authenticating nobody — the exact silent-pass this
 * script exists to prevent.
 *
 * A public handler authenticates with `authorizePublicRequest` (the whole chain:
 * switch, key, rate limit, company filter) or, if it needs the key's own
 * identity, `requireApiKey` plus the rest of that chain by hand. Both still
 * count. SELF_TESTS asserts all three verdicts, in both directions.
 */
const GUARD_PATTERN =
  /\b(requireAuth|requireSuperAdmin|requireFullSession|authorizePublicRequest|requireApiKey|authorizeCronRequest)\s*\(/;

/**
 * Handlers that are deliberately reachable without a session, with the reason.
 *
 * Keep this list SHORT and justify every entry. Adding one is a security
 * decision: it says an unauthenticated caller may reach this code. Anything
 * here must be safe to expose to the internet with no credentials at all.
 */
const PUBLIC_HANDLERS = {
  "auth/login/route.ts": {
    POST: "Issues the session. Rate-limited per IP and per account.",
  },
  "auth/logout/route.ts": {
    POST: "Clears the cookie. Deliberately unguarded so a session that has already been terminated can still log itself out.",
  },
  "auth/setup/route.ts": {
    GET: "Reports only whether the instance still needs first-run setup. No data, no session.",
    POST: "First-run wizard. Self-guards by refusing once any user exists.",
  },
  "branding/logo/route.ts": {
    GET: "White-label logo, rendered by the login page before anyone has signed in.",
  },
  "branding/favicon/route.ts": {
    GET: "White-label favicon, rendered by the login page before anyone has signed in.",
  },
};

/**
 * Handlers that authenticate with `getAuthFromRequest` instead of a guard.
 *
 * These exist because `requireAuth` is too strict for them — they must stay
 * reachable while a session is pending MFA enrolment, or they re-issue the
 * cookie themselves. The cost is that the checks `requireAuth` performs are not
 * inherited and have to be written out by hand, which is exactly what went
 * wrong: `mfa/setup` and `mfa/verify` were missing both of them, so a suspended
 * account could still complete enrolment and be handed a fresh session token.
 *
 * So this list is not an exemption. Every handler on it must call
 * `getAuthFromRequest` *and* every check below.
 *
 * The requirement list grows whenever `requireAuth` gains a check — and it has
 * to grow in the same change, or this assertion quietly covers only part of the
 * rule while still reporting green, which is worse than asserting nothing.
 * `isUserDeleted` was added for exactly that reason.
 */
const SELF_GUARDED_HANDLERS = {
  "auth/change-password/route.ts": { POST: "Re-issues the caller's cookie with a bumped session epoch." },
  "auth/me/route.ts": { GET: "Must stay reachable during pending-MFA enrolment." },
  "auth/mfa/setup/route.ts": { POST: "Enrolment: reached while the session is pending MFA." },
  "auth/mfa/verify/route.ts": { POST: "Enrolment: reached while the session is pending MFA; issues a new token." },
  "auth/ping/route.ts": { POST: "Keep-alive: must stay reachable during pending-MFA enrolment." },
};

/**
 * What a self-guarded handler must spell out, since it inherits nothing.
 *
 * CLAUDE.md states the standing rule: a check added to `requireAuth` must be
 * added here in the same change, or this script keeps reporting green while
 * asserting only part of it.
 *
 * **`pendingMfaEnrollment` is the documented exception, and the only one.**
 * `requireAuth` rejects a half-enrolled session. **Three** of the five handlers
 * on this list must stay reachable *during* that enrolment and therefore must
 * not inherit it — `mfa/setup` and `mfa/verify`, which perform the enrolment,
 * and `auth/me`, which the enrolment page reads. Asserting it of those would
 * mean the enrolment flow refusing the enrolment flow, and the first person to
 * satisfy the assertion would lock every forced-MFA user out of the only page
 * they may reach.
 *
 * The other two — `auth/ping` and `auth/change-password` — are **not** part of
 * the flow (`proxy.ts` refuses both during enrolment; they are on this list for
 * unrelated reasons, and nothing pings from `/setup-mfa`). They check
 * `pendingMfaEnrollment` explicitly in their own bodies instead, so the rule is
 * satisfied in substance for them. It is not asserted mechanically here only
 * because this list is all-or-nothing and the other three genuinely must be
 * exempt. An earlier draft of this comment claimed all five had to be; that was
 * wrong, and it is the kind of wrong that makes a residual gap look intended.
 */
const SELF_GUARD_REQUIREMENTS = [
  { name: "getAuthFromRequest", re: /\bgetAuthFromRequest\s*\(/ },
  { name: "isUserDisabled", re: /\bisUserDisabled\s*\(/ },
  { name: "isUserDeleted", re: /\bisUserDeleted\s*\(/ },
  { name: "isSessionEpochStale", re: /\bisSessionEpochStale\s*\(/ },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/**
 * Blank everything in a source file that is not executable code, so no matcher
 * in this script can be fooled by text that merely *mentions* a guard.
 *
 * This pass is the difference between a check and a hypothesis. Every assertion
 * below is a regex over file text, and before this existed a single line like
 *
 *     // await requireAuth(request, "Admin");   <- just for a minute
 *
 * inside a handler body was enough to report that handler as guarded, with CI
 * staying green (ESLint only *warns* about the now-unused import). A
 * commented-out guard is exactly the artefact someone leaves behind when they
 * disable one temporarily, so the false negative landed where it did the most
 * damage. The same held for a guard named in a JSDoc block or in a string.
 *
 * It also closes a quieter hole in the other direction: `extractBody` counts
 * braces, and a "{" or "}" inside a string or template literal used to be
 * counted, so a body could terminate early (reporting a guarded handler as
 * UNGUARDED) or run long (swallowing the sibling handler after it, whose own
 * guard would then be credited to the wrong method). Stripping FIRST and brace
 * counting afterwards makes the two consistent — modulo the one construct this
 * scanner cannot resolve without a parser, which `regexCanStartHere` refuses to
 * guess at rather than getting silently wrong.
 *
 * Stripped spans are replaced with spaces and newlines are preserved, so the
 * stripped text still lines up with the original byte for byte. Nothing here
 * consumes that today — it is kept so the pass stays a drop-in, and so a future
 * caller can report an original line number without a second mapping.
 *
 * `keepStrings` blanks comments and regex bodies but leaves string and template
 * contents intact — for the one consumer (proxy.ts's route literals) that has
 * to read the strings themselves and only wants the comments gone. The scanner
 * still *tracks* those literals either way, so a quote or brace inside one can
 * never desynchronise it.
 *
 * Dependency-free by design: this script is plain Node and the CI job that runs
 * it must not need an install, so there is no parser here — the scanner is a
 * lexer-shaped approximation, and SELF_TESTS below is what keeps it honest.
 *
 * `label` names the file in the one diagnostic this can emit.
 */
function stripNonCode(src, { keepStrings = false, label = "<source>" } = {}) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };

  // Keywords after which a "/" can only begin a regex literal, never division.
  const REGEX_PRECEDING_KEYWORDS = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "case", "do", "else", "yield", "await", "throw",
  ]);

  /**
   * Is the "/" at this point a regex literal or a division sign?
   *
   * JavaScript cannot answer that without a parser, so this uses the standard
   * previous-token heuristic. The bias is deliberate: we treat "/" as a regex
   * in the ambiguous cases. Guessing "regex" when it was division blanks a span
   * of real code, which can only *lose* a guard match and make this script
   * complain — a false alarm a human resolves in seconds. Guessing "division"
   * when it was a regex leaves the regex body in play as code, and a quote
   * inside it would then open a phantom string that swallows the rest of the
   * file — silently, and in the direction of passing. So: fail loud, not quiet.
   *
   * The one position where the heuristic cannot pick a safe direction is a "/"
   * straight after ")". Both readings are common there — `if (x) /re/.test(s)`
   * is a regex, `(a + b) / c` is division — and unlike every other case, being
   * wrong about it has a concrete, demonstrated cost in the passing direction:
   *
   *     export async function GET(request) {
   *       if (s) /\{/.test(s);          // no guard anywhere in this handler
   *       return NextResponse.json({});
   *     }
   *     export async function POST(request) { await requireAuth(request); }
   *
   * Read as division, the regex's "{" is counted, GET's body runs long, it
   * swallows POST — and GET is reported guarded on the strength of POST's
   * guard. That is a silent false pass on an unguarded handler, which is the
   * exact failure this script exists to prevent.
   *
   * So this case is not guessed at all: `ambiguousSlashAfterParen` stops the
   * run and names the line to disambiguate. It cannot fire on the tree as it
   * stands, but `/` after `)` is ordinary arithmetic here — `Math.floor(Date.now()
   * / 1000)`, `Math.ceil((lo + hi) / 2)` — so the stop is tuned to leave plain
   * division alone; see `findRegexEnd`. A loud stop a human resolves in a minute
   * beats a green check that is not telling the truth.
   */
  const regexCanStartHere = (prev, prevWord) => {
    if (prevWord) return REGEX_PRECEDING_KEYWORDS.has(prevWord);
    if (prev === "") return true; // start of file
    return "(,=:[!&|?{};+-*%^~<>".includes(prev);
  };

  /**
   * Stop the run rather than guess. Thrown, not printed-and-exited, so
   * `stripNonCode` stays a pure function the self-tests can drive.
   *
   * The wording matters as much as the stop. An earlier version said the slash
   * was "ambiguous" and told the reader to parenthesise the division — but when
   * this fires on `Date.now() / 1000; // unix seconds` the slash is not
   * ambiguous at all, and parenthesising does nothing, because the ambiguity
   * came from the "/" in the trailing comment. A contributor who cannot make the
   * suggested fix work deletes the check instead, which is the worst outcome
   * available. So: say what is being assumed, and give remedies that work.
   */
  const ambiguousSlashAfterParen = (i) => {
    const lineNo = src.slice(0, i).split("\n").length;
    const lineEnd = src.indexOf("\n", i);
    const line = src.slice(src.lastIndexOf("\n", i) + 1, lineEnd === -1 ? undefined : lineEnd);
    const err = new Error(
      `${label}:${lineNo} — reading this "/" as division, but it could open a regex literal:\n\n` +
        `  ${line.trim()}\n\n` +
        `A "/" straight after ")" is the one construct this scanner cannot settle\n` +
        `without a full parser, and it will not guess: if that "/" really opens a\n` +
        `regex, its braces land in the brace count used to find where a handler\n` +
        `body ends, which can silently credit an unguarded handler with the next\n` +
        `handler's guard.\n\n` +
        `Two fixes that work:\n` +
        `  - If it is division and something later on the line contains a "/"\n` +
        `    (a string, a path), move that part to its own line — or hoist the\n` +
        `    left-hand operand: \`const t = Date.now();\` then \`t / 1000\`.\n` +
        `  - If it really is a regex, hoist it to a named const and use that.\n\n` +
        `Wrapping the division in parentheses does NOT help — the "/" still\n` +
        `follows a ")".\n`
    );
    err.ambiguousSlash = true;
    throw err;
  };

  // i points just past the opening backtick; returns the index just past the
  // closing one. `${...}` substitutions hold real code, so they are handed back
  // to scanCode rather than blanked — mutual recursion handles the nesting
  // (a template inside a substitution inside a template, and so on).
  function scanTemplate(i) {
    let start = i;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") {
        if (!keepStrings) blank(start, i);
        return i + 1;
      }
      if (c === "$" && src[i + 1] === "{") {
        if (!keepStrings) blank(start, i);
        i = scanCode(i + 2, true);
        start = i;
        continue;
      }
      i++;
    }
    if (!keepStrings) blank(start, i);
    return i;
  }

  /**
   * i points at a "/". If a regex literal could close on this line, returns
   * {close, end} — the closing "/" and the index just past its flags. A newline
   * first means this cannot be a regex, so null: it was division.
   *
   * `skipComments` exists because the two callers ask different questions, and
   * answering both with one rule set was a live false pass.
   *
   *   - The ")" probe asks "COULD a regex plausibly close on this line, or is
   *     the next '/' merely opening a comment?". It runs over raw source with
   *     nothing classified yet, so a trailing `// unix seconds` answers it and
   *     `Date.now() / 1000;` stopped the build the moment someone commented the
   *     line. It passes skipComments: a genuine regex cannot contain "//" or
   *     "/*" unescaped outside a character class, because the first "/" of the
   *     pair would already have closed it.
   *
   *   - The real regex scan asks "WHERE does this regex end?", having already
   *     decided it is a regex. There the first "/" outside a character class
   *     ends it, unconditionally — what follows that "/" is irrelevant. Applying
   *     the comment rule here made `const re = /\{/// x` return null, so the
   *     regex was re-read as division and its "{" stayed live in the brace
   *     count: the handler's body ran long and swallowed the next handler's
   *     guard. Pathological source, but a false pass in the one check whose
   *     purpose is not to have them, and TypeScript parses it without complaint.
   *
   * Known residual on the probe side: a lone "/" inside a string later on the
   * same line (`"a/b"`) still answers it and still stops the run. Strings are
   * deliberately NOT skipped, and unlike comments they cannot be: a comment
   * opener has an unambiguous local rule, a quote has none — a quote inside a
   * character class is regex content, a quote in code opens a string, and
   * nothing local tells them apart. Skipping would mean `if (x) /['"]/.test(s)`
   * opens a "string" at the quote, finds no closer before end of line, returns
   * null, and the stop never fires — leaving a regex read as division, which is
   * the phantom-string false pass this whole branch exists to prevent, firing on
   * exactly the regexes most able to do damage. The message names a remedy.
   */
  function findRegexEnd(i, skipComments = false) {
    let j = i + 1;
    let inClass = false; // "/" is an ordinary character inside [...]
    while (j < src.length) {
      const c = src[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "\n") return null;
      if (inClass) { if (c === "]") inClass = false; }
      else if (c === "[") inClass = true;
      else if (c === "/") {
        if (skipComments && src[j + 1] === "/") return null; // rest of line is a comment
        if (skipComments && src[j + 1] === "*") {
          const end = src.indexOf("*/", j + 2);
          // A regex literal cannot span lines, so a block comment that does
          // ends the search just as a newline would.
          if (end === -1 || src.slice(j, end).includes("\n")) return null;
          j = end + 2;
          continue;
        }
        const close = j;
        j++;
        while (j < src.length && /[a-z]/.test(src[j])) j++; // flags
        return { close, end: j };
      }
      j++;
    }
    return null;
  }

  // Scans code. With `stopAtCloseBrace` we are inside a `${ ... }` and return
  // on the "}" that closes it.
  function scanCode(i, stopAtCloseBrace = false) {
    let depth = 0;
    let prev = "";     // last significant character
    let prevWord = ""; // last identifier/keyword, for the regex heuristic
    while (i < src.length) {
      const c = src[i];
      const c2 = src[i + 1];

      if (c === "/" && c2 === "/") {
        let j = i;
        while (j < src.length && src[j] !== "\n") j++;
        blank(i, j);
        i = j;
        continue;
      }
      if (c === "/" && c2 === "*") {
        const end = src.indexOf("*/", i + 2);
        const j = end === -1 ? src.length : end + 2;
        blank(i, j);
        i = j;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < src.length) {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === c || src[j] === "\n") break;
          j++;
        }
        // The quotes stay; only the contents go, so the token still reads as a
        // string to anything downstream that cares about shape.
        if (!keepStrings) blank(i + 1, Math.min(j, src.length));
        i = src[j] === c ? j + 1 : j;
        prev = c;
        prevWord = "";
        continue;
      }
      if (c === "`") {
        i = scanTemplate(i + 1);
        prev = "`";
        prevWord = "";
        continue;
      }
      if (c === "/") {
        // ")" is the one position where both readings are plausible and the
        // wrong one fails silently — stop instead of guessing. See above.
        // skipComments: true — this is the "could a regex close here?" probe,
        // not the scan that locates a known regex's end. See findRegexEnd.
        if (prev === ")" && !prevWord && findRegexEnd(i, true)) ambiguousSlashAfterParen(i);
        const found = regexCanStartHere(prev, prevWord) ? findRegexEnd(i) : null;
        if (found) {
          blank(i + 1, found.close);
          i = found.end;
          prev = "/";
          prevWord = "";
          continue;
        }
        // Division, or a "/" that opens nothing: fall through and treat it as
        // an ordinary operator character.
      }
      if (/[A-Za-z_$]/.test(c)) {
        // Consume the whole identifier so `prevWord` is a word, not a letter.
        let j = i;
        while (j < src.length && /[\w$]/.test(src[j])) j++;
        prevWord = src.slice(i, j);
        prev = src[j - 1];
        i = j;
        continue;
      }

      if (c === "{") depth++;
      else if (c === "}") {
        if (stopAtCloseBrace && depth === 0) return i + 1;
        depth--;
      }
      if (!/\s/.test(c)) {
        prev = c;
        prevWord = "";
      }
      i++;
    }
    return i;
  }

  scanCode(0);
  return out.join("");
}

/**
 * Extract a function's balanced {...} body.
 *
 * Always call this with source that has been through `stripNonCode` — the brace
 * counting below is otherwise confused by braces inside strings, template
 * literals and comments.
 *
 * `openParen` is the index of the "(" starting the parameter list. Skipping past
 * the matching ")" first is load-bearing: these handlers are routinely declared
 * as `function GET(request, { params }: {...})`, so the first "{" after the
 * function name belongs to a destructured parameter, not the body — reading that
 * instead reports every such handler as unguarded.
 */
function extractBody(src, openParen) {
  let depth = 0;
  let i = openParen;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  const start = src.indexOf("{", i);
  if (start === -1) return "";
  depth = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return src.slice(start);
}

/**
 * Bodies of non-handler functions declared in the same file, so a handler that
 * delegates its auth to a local helper still counts as guarded.
 */
function localHelperBodies(src) {
  const bodies = new Map();
  const re = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)) continue;
    bodies.set(name, extractBody(src, m.index + m[0].length - 1));
  }
  return bodies;
}

function isGuarded(body, helpers) {
  if (GUARD_PATTERN.test(body)) return true;
  // One level of indirection: a local helper that itself guards.
  for (const [name, helperBody] of helpers) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(body) && GUARD_PATTERN.test(helperBody)) {
      return true;
    }
  }
  return false;
}

/** Calls that make a route a cron endpoint, cross-checked against proxy.ts below. */
const CRON_PATTERN = /\bauthorizeCronRequest\s*\(/;

/**
 * The whole per-file analysis, as a pure function of the source text.
 *
 * Split out from the loop below so SELF_TESTS can drive the *production* path
 * with fixture sources instead of re-implementing it. A self-test that exercises
 * a parallel copy of the logic proves nothing about the copy that runs in CI.
 */
function analyseSource(rawSrc, label) {
  // Comments and literals are blanked before anything is matched or counted;
  // see stripNonCode. Everything below reads this, never the raw file.
  const src = stripNonCode(rawSrc, { label });
  const helpers = localHelperBodies(src);
  const handlers = new Map();

  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    // Keep the FIRST declaration of a duplicated method, not the last. A file
    // with two `export async function GET` does not compile (TS2323/TS2393), so
    // `CI / check` rejects it before this runs — but if it ever reaches here,
    // last-wins would let a guarded second copy mask an unguarded first one,
    // which is the passing direction. This Map replaced a push-per-match loop,
    // so without the guard the extraction would have quietly changed that.
    if (handlers.has(m[1])) continue;
    const body = extractBody(src, m.index + m[0].length - 1);
    handlers.set(m[1], {
      guarded: isGuarded(body, helpers),
      missingSelfGuards: SELF_GUARD_REQUIREMENTS.filter((r) => !r.re.test(body)).map(
        (r) => r.name
      ),
    });
  }

  // Cron detection stays a WHOLE-FILE test, deliberately. Narrowing it to the
  // handler bodies scanned above looks tidier and silently loses coverage: an
  // arrow-function helper (`const cronOk = async (r) => authorizeCronRequest(r)`)
  // or two levels of indirection are invisible to body scanning, so a route with
  // the cron half and no proxy.ts half would pass — which is the precise failure
  // this cross-check was added for after the daily credential check spent twenty
  // releases silently 401ing. Real cron routes are dual-guarded
  // (`authorizeCronRequest` OR `requireSuperAdmin`), so nothing else is loud
  // about it either. The comment/string false positive that motivated narrowing
  // is already fully handled by stripping the source first.
  return { handlers, cron: CRON_PATTERN.test(src) };
}

/**
 * Fixtures for the scanner, run on every invocation before the real scan.
 *
 * This script IS the guarantee that every handler authenticates, and until
 * these existed nothing checked it back. It is also no longer trivial: the
 * comment/literal stripper is a hand-rolled lexer, and a lexer that quietly
 * mis-scans one construct turns the whole check green for the wrong reason.
 * Each case below is a hole that was real — most were demonstrated against an
 * earlier version of this file, which passed them all while an unguarded
 * handler sat in the tree.
 *
 * `guarded` asserts a per-method verdict; `cron` asserts the cron cross-check's
 * view of the file. They run through `analyseSource`, the same function the
 * loop below uses, so they cannot drift away from what CI actually does.
 *
 * Cheap to extend: add a case whenever this scanner is taught something new.
 */
const SELF_TESTS = [
  {
    name: "guard in a line comment does not count",
    src: `export async function GET(r) { // await requireAuth(r);\n return 1; }`,
    guarded: { GET: false },
  },
  {
    name: "guard in a block comment does not count",
    src: `export async function GET(r) { /* await requireAuth(r); */ return 1; }`,
    guarded: { GET: false },
  },
  {
    name: "guard in a string literal does not count",
    src: `export async function GET(r) { const s = "requireAuth(r)"; return s; }`,
    guarded: { GET: false },
  },
  {
    name: "guard in a template literal does not count",
    src: "export async function GET(r) { const s = `requireSuperAdmin(r)`; return s; }",
    guarded: { GET: false },
  },
  {
    name: "guard inside a ${} substitution is real code and does count",
    src: "export async function GET(r) { const s = `x${await requireAuth(r)}y`; return s; }",
    guarded: { GET: true },
  },
  {
    name: "a regex containing quotes and braces does not desynchronise the scan",
    src: `export async function GET(r) { const re = /["'{}]/g; await requireAuth(r); return re; }`,
    guarded: { GET: true },
  },
  {
    name: "an unbalanced brace in a string does not truncate the body",
    src: `export async function GET(r) {\n const b = "} unbalanced { here";\n await requireAuth(r);\n return b;\n}`,
    guarded: { GET: true },
  },
  {
    name: "an unbalanced brace in a string does not let a body swallow its sibling's guard",
    src:
      `export async function GET(r) {\n const b = "unmatched { here";\n return b;\n}\n` +
      `export async function POST(r) {\n await requireAuth(r);\n return 1;\n}`,
    guarded: { GET: false, POST: true },
  },
  {
    name: "a self-guarded handler missing a required check is reported",
    src: `export async function GET(r) { const a = await getAuthFromRequest(r); await isUserDisabled(a.sub); return 1; }`,
    missingSelfGuards: { GET: ["isUserDeleted", "isSessionEpochStale"] },
  },
  {
    name: "cron auth reached through an arrow-function helper is still seen",
    src:
      `const cronOk = async (r) => authorizeCronRequest(r);\n` +
      `export async function POST(r) {\n` +
      `  if (!(await cronOk(r))) { await requireSuperAdmin(r); }\n` +
      `  return 1;\n}`,
    guarded: { POST: true },
    cron: true,
  },
  {
    name: "cron auth named only in a comment is not seen",
    src: `// historically: authorizeCronRequest(r)\nexport async function POST(r) { await requireAuth(r); return 1; }`,
    guarded: { POST: true },
    cron: false,
  },
  {
    name: "a guard reached through a local helper counts",
    src:
      `function guard(r) { return requireAuth(r, "Admin"); }\n` +
      `export async function GET(r) { await guard(r); return 1; }`,
    guarded: { GET: true },
  },
  {
    name: "a local helper that does NOT guard does not launder an unguarded handler",
    src:
      `function shape(r) { return { ok: true }; }\n` +
      `export async function GET(r) { return shape(r); }`,
    guarded: { GET: false },
  },
  {
    name: "a regex after ) stops the run rather than being read as division",
    src: `export async function GET(r) {\n if (r) /\\{/.test("x");\n return 1;\n}\nexport async function POST(r) { await requireAuth(r); return 1; }`,
    stops: true,
  },
  {
    name: "plain division after ) with a trailing comment does not stop the run",
    src: `export async function GET(r) {\n const ms = Math.floor(Date.now() / 1000); // unix seconds\n await requireAuth(r);\n return ms;\n}`,
    guarded: { GET: true },
  },
  {
    name: "plain division after ) followed by a block comment does not stop the run",
    src: `export async function GET(r) {\n const n = Date.now() / 2; /* see lib/x.ts */\n await requireAuth(r);\n return n;\n}`,
    guarded: { GET: true },
  },
  {
    name: "division between two slashes on one line does not swallow the guard",
    // Catches a `regexCanStartHere` that returns true unconditionally: it would
    // read `/ 2; await requireAuth(r); const y = b /` as one regex literal and
    // blank the guard out of existence.
    src: `export async function GET(r) {\n const x = r.a / 2; await requireAuth(r); const y = r.b / 3;\n return x + y;\n}`,
    guarded: { GET: true },
  },
  {
    name: "a regex whose closing slash is followed by a comment opener still ends there",
    // The two findRegexEnd callers ask different questions. Applying the
    // probe's comment rule to the real regex scan made this regex read as
    // division, leaving its "{" in the brace count so GET's body ran on and
    // swallowed POST's guard — an unguarded handler reported guarded.
    src: `export async function GET(r) {\n const re = /\\{/// unbalanced\n return re;\n}\nexport async function POST(r) { await requireAuth(r); return 1; }`,
    guarded: { GET: false, POST: true },
  },
  {
    name: "a regex whose closing slash is followed by a block-comment opener still ends there",
    src: `export async function GET(r) {\n const re = /\\{/*2;\n return re;\n}\nexport async function POST(r) { await requireAuth(r); return 1; }`,
    guarded: { GET: false, POST: true },
  },
  {
    name: "a duplicated handler keeps the first (unguarded) declaration",
    src:
      `export async function GET(r) { return 1; }\n` +
      `export async function GET(r) { await requireAuth(r); return 1; }`,
    guarded: { GET: false },
  },
  // The three public-API verdicts. GUARD_PATTERN once accepted the global
  // on/off switch as authentication, so a handler shaped exactly like the first
  // case below passed this check while verifying no credential at all. These
  // assert the negative AND both positives: a pattern that only ever says "yes"
  // is not a check, and dropping one of the two real guards would be just as
  // bad a regression in the other direction.
  {
    name: "the public-API on/off switch alone does not authenticate anybody",
    src:
      `export async function GET(r) {\n` +
      `  const disabled = await ensurePublicApiEnabled();\n` +
      `  if (disabled) return disabled;\n` +
      `  return NextResponse.json({ students: await prisma.student.findMany() });\n}`,
    guarded: { GET: false },
  },
  {
    name: "authorizePublicRequest counts as a guard",
    src:
      `export async function GET(r) {\n` +
      `  const ctx = await authorizePublicRequest(r);\n` +
      `  if (ctx instanceof NextResponse) return ctx;\n` +
      `  return NextResponse.json({ ok: true });\n}`,
    guarded: { GET: true },
  },
  {
    name: "requireApiKey counts even alongside the on/off switch (the index route's shape)",
    src:
      `export async function GET(r) {\n` +
      `  const disabled = await ensurePublicApiEnabled();\n` +
      `  if (disabled) return disabled;\n` +
      `  const auth = await requireApiKey(r);\n` +
      `  return NextResponse.json({ keyName: auth.name });\n}`,
    guarded: { GET: true },
  },
];

/**
 * Fixtures for `keepStrings`, which no verdict-level fixture reaches — the only
 * caller is the proxy.ts route harvest, and that survives today only because
 * losing it would make the cron cross-check notice. Asserted directly instead.
 */
const STRIP_TESTS = [
  {
    name: "keepStrings keeps string contents",
    src: `const p = "/api/cron/run"; // pathname === "/api/other"`,
    keepStrings: true,
    includes: [`"/api/cron/run"`],
    excludes: [`"/api/other"`],
  },
  {
    name: "default mode blanks string contents",
    src: `const p = "/api/cron/run";`,
    keepStrings: false,
    excludes: [`/api/cron/run`],
  },
];

function runSelfTests() {
  const failures = [];
  for (const t of SELF_TESTS) {
    let got;
    try {
      got = analyseSource(t.src, `<self-test: ${t.name}>`);
      if (t.stops) {
        failures.push(`${t.name}: expected the scanner to refuse, but it returned a verdict`);
        continue;
      }
    } catch (err) {
      if (t.stops && err.ambiguousSlash) continue; // refused, as required
      failures.push(`${t.name}: threw ${err.message}`);
      continue;
    }
    for (const [method, want] of Object.entries(t.guarded ?? {})) {
      const info = got.handlers.get(method);
      if (!info) failures.push(`${t.name}: ${method} was not found at all`);
      else if (info.guarded !== want) {
        failures.push(`${t.name}: ${method} guarded=${info.guarded}, expected ${want}`);
      }
    }
    for (const [method, want] of Object.entries(t.missingSelfGuards ?? {})) {
      const info = got.handlers.get(method);
      if (!info) failures.push(`${t.name}: ${method} was not found at all`);
      else if (info.missingSelfGuards.join(",") !== want.join(",")) {
        failures.push(
          `${t.name}: ${method} missing=[${info.missingSelfGuards}], expected [${want}]`
        );
      }
    }
    if (t.cron !== undefined && got.cron !== t.cron) {
      failures.push(`${t.name}: cron=${got.cron}, expected ${t.cron}`);
    }
  }

  for (const t of STRIP_TESTS) {
    const got = stripNonCode(t.src, {
      keepStrings: t.keepStrings,
      label: `<self-test: ${t.name}>`,
    });
    for (const want of t.includes ?? []) {
      if (!got.includes(want)) failures.push(`${t.name}: lost ${JSON.stringify(want)}`);
    }
    for (const want of t.excludes ?? []) {
      if (got.includes(want)) failures.push(`${t.name}: kept ${JSON.stringify(want)}`);
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} self-test failure(s) in this script:\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      "\nThe scanner in scripts/check-route-guards.mjs is misreading source, so\n" +
        "its verdict on the real tree cannot be trusted either. Fix the scanner\n" +
        "before reading anything else this run printed.\n"
    );
    process.exit(1);
  }
  return SELF_TESTS.length + STRIP_TESTS.length;
}

const selfTestCount = runSelfTests();

const files = walk(API_ROOT).sort();
const rows = [];
const violations = [];
const staleAllowlist = [];
/** Route paths whose source accepts cron auth — filled in as we go. */
const cronHandlerRoutes = new Set();

for (const file of files) {
  const rel = relative(API_ROOT, file).split(sep).join("/");
  let analysis;
  try {
    analysis = analyseSource(readFileSync(file, "utf8"), rel);
  } catch (err) {
    // The scanner refused to guess at a "/" it cannot classify. Stop here: any
    // verdict this run produced for other files is fine, but continuing past an
    // unreadable one would report a green check over a file nobody scanned.
    if (!err.ambiguousSlash) throw err;
    console.error(`\n${err.message}`);
    process.exit(1);
  }
  const { handlers, cron } = analysis;
  if (cron) cronHandlerRoutes.add("/api/" + rel.replace(/\/route\.ts$/, ""));

  const allowed = PUBLIC_HANDLERS[rel] ?? {};
  const selfGuarded = SELF_GUARDED_HANDLERS[rel] ?? {};
  const seen = new Set();

  for (const [method, info] of handlers) {
    seen.add(method);
    const guarded = info.guarded;
    const exempt = Object.hasOwn(allowed, method);
    const isSelfGuarded = Object.hasOwn(selfGuarded, method);

    if (isSelfGuarded) {
      // Not an exemption: verify it really does perform the checks by hand.
      const missing = info.missingSelfGuards;
      rows.push({
        rel,
        method,
        state: missing.length ? "INCOMPLETE" : "self-guarded",
      });
      if (missing.length) {
        violations.push(
          `${rel}  ${method} — self-guarded but missing: ${missing.join(", ")}`
        );
      }
      continue;
    }

    rows.push({ rel, method, state: guarded ? "guarded" : exempt ? "public" : "UNGUARDED" });

    if (!guarded && !exempt) violations.push(`${rel}  ${method}`);
    if (guarded && exempt) {
      staleAllowlist.push(`${rel}  ${method} — guarded, so the allow-list entry is stale`);
    }
  }

  for (const method of Object.keys(selfGuarded)) {
    if (!seen.has(method)) {
      staleAllowlist.push(
        `${rel}  ${method} — listed as self-guarded but no such handler exists`
      );
    }
  }

  for (const method of Object.keys(allowed)) {
    if (!seen.has(method)) {
      staleAllowlist.push(`${rel}  ${method} — allow-listed but no such handler exists`);
    }
  }
}

/**
 * Cron endpoints must be listed in BOTH places or they do not work.
 *
 * A handler accepting cron auth is only reachable if `proxy.ts` also lets the
 * request through — the proxy runs first and has no idea what the handler
 * accepts. `credentials/check` had the handler half and not the proxy half, so
 * the daily credential health check was rejected before it ever arrived and
 * silently never ran. The two lists are compared here so that cannot recur.
 *
 * Both sides are read from stripped source, so a commented-out mention on
 * either side no longer counts — but both stay WHOLE-FILE scans, because
 * narrowing either one trades a real class of miss for a hypothetical one.
 * See the note in `analyseSource`.
 */
const cronMismatches = [];
{
  const handlerRoutes = cronHandlerRoutes;
  // Comments only: the route literals themselves are what we are reading, so
  // the strings have to survive. This is purely so a commented-out
  // `pathname === "/api/..."` in proxy.ts is not mistaken for a live one.
  const proxySrc = stripNonCode(
    readFileSync(join(process.cwd(), "src", "proxy.ts"), "utf8"),
    { keepStrings: true, label: "src/proxy.ts" }
  );
  const proxyRoutes = new Set(
    [...proxySrc.matchAll(/pathname === "(\/api\/[^"]+)"/g)].map((m) => m[1])
  );
  for (const r of handlerRoutes) {
    if (!proxyRoutes.has(r)) {
      cronMismatches.push(`${r} — handler accepts cron auth, but proxy.ts does not let it through`);
    }
  }
  for (const r of proxyRoutes) {
    if (!handlerRoutes.has(r)) {
      cronMismatches.push(`${r} — proxy.ts lets cron through, but the handler does not call authorizeCronRequest`);
    }
  }
}

if (process.argv.includes("--inventory")) {
  const width = Math.max(...rows.map((r) => r.rel.length));
  for (const r of rows) {
    console.log(`${r.rel.padEnd(width)}  ${r.method.padEnd(6)}  ${r.state}`);
  }
  const counts = rows.reduce((a, r) => ((a[r.state] = (a[r.state] ?? 0) + 1), a), {});
  console.log(
    `\n${files.length} route files, ${rows.length} handlers — ` +
      Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")
  );
}

let failed = false;

if (violations.length) {
  failed = true;
  console.error(
    `\n${violations.length} handler(s) under src/app/api/** have no auth guard:\n`
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nAdd one of requireAuth / requireSuperAdmin / requireFullSession /\n" +
      "authorizePublicRequest / requireApiKey / authorizeCronRequest, or — if the\n" +
      "handler is genuinely meant to be reachable with no session — add it to\n" +
      "PUBLIC_HANDLERS in scripts/check-route-guards.mjs with the reason.\n"
  );
}

if (cronMismatches.length) {
  failed = true;
  console.error(`\n${cronMismatches.length} cron endpoint mismatch(es):\n`);
  for (const c of cronMismatches) console.error(`  ${c}`);
  console.error(
    "\nA cron endpoint must appear in proxy.ts's isCronRequest list AND call\n" +
      "authorizeCronRequest in its handler. With only one, the job fails with a\n" +
      "401 that looks like a credentials problem.\n"
  );
}

if (staleAllowlist.length) {
  failed = true;
  console.error(`\n${staleAllowlist.length} stale PUBLIC_HANDLERS entr(y/ies):\n`);
  for (const s of staleAllowlist) console.error(`  ${s}`);
  console.error("\nRemove them so the list keeps meaning what it says.\n");
}

if (failed) process.exit(1);

if (!process.argv.includes("--inventory")) {
  const publicCount = rows.filter((r) => r.state === "public").length;
  console.log(
    `Route guards OK — ${rows.length} handlers across ${files.length} routes ` +
      `(${publicCount} intentionally public); ${selfTestCount} scanner self-tests passed.`
  );
}
