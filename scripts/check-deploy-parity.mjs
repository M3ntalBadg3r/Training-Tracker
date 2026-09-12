#!/usr/bin/env node
/**
 * Deploy/app parity check — the two cross-language invariants CLAUDE.md says
 * must never drift, plus the third leg of the cron triangle.
 *
 * ## Why this exists
 *
 * Two pairs of literals live on opposite sides of a process boundary, in
 * different languages, and nothing connects them but a comment asking the next
 * person to remember:
 *
 *   1. `UPDATE_REQUESTS` in src/lib/update-request.ts, against the `case` arms
 *      in deploy/update-agent.sh. The app writes one of three exact strings to
 *      a request file; a root-owned helper matches the whole string against a
 *      closed set. They are an enum shared across a process boundary. If they
 *      drift, EVERY UPDATE SILENTLY STOPS WORKING — the agent simply rejects
 *      the request as unrecognised, which looks like nothing happening.
 *
 *   2. `cronSigningString` in src/lib/cron-auth.ts, against
 *      `cron_signing_string` in deploy/lib/cron-sign.sh. Both sides build the
 *      string that is HMAC'd. If they drift, EVERY SCHEDULED BACKUP, EXPORT AND
 *      CREDENTIAL CHECK starts returning 401 — and the failure reads like a
 *      credentials problem, so it gets debugged in the wrong place.
 *
 * Both failures are silent by construction: nothing raises, nothing logs an
 * error anyone reads, the work just stops. That is precisely the class of bug
 * that has to be caught mechanically rather than remembered.
 *
 * ## The third leg
 *
 * scripts/check-route-guards.mjs already cross-checks the proxy's cron list
 * against the handlers. It cannot see the cron SCRIPTS, which are the other end
 * of the same wire: a script signs a path and sends an `X-Auto-*` header, and
 * the proxy only recognises a request when BOTH match. CLAUDE.md records the
 * live instance — `credentials/check` had the handler half but not the proxy
 * half, and the daily credential check silently 401'd and never ran. This check
 * closes that triangle from the deploy side.
 *
 * ## How it compares
 *
 * By EXECUTION where it can, not by eyeballing two regexes. The cron signing
 * string is produced by actually running the shell function and actually
 * evaluating the TypeScript template literal, for the (method, path) pairs the
 * cron scripts really use. A textual comparison would pass two expressions that
 * merely look alike; running them compares what the two sides will do.
 *
 * Where it must parse, it refuses to guess: if a definition is not in the shape
 * this script knows how to read, it fails loudly rather than quietly matching
 * nothing. A parse that silently finds zero literals would report parity
 * between two empty sets.
 *
 * Usage:
 *   node scripts/check-deploy-parity.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const UPDATE_REQUEST_TS = join(ROOT, "src", "lib", "update-request.ts");
const UPDATE_AGENT_SH = join(ROOT, "deploy", "update-agent.sh");
const CRON_AUTH_TS = join(ROOT, "src", "lib", "cron-auth.ts");
const CRON_SIGN_SH = join(ROOT, "deploy", "lib", "cron-sign.sh");
const PROXY_TS = join(ROOT, "src", "proxy.ts");
const CRON_SCRIPTS = [
  "auto-backup.sh",
  "auto-export.sh",
  "auto-credential-check.sh",
].map((f) => join(ROOT, "deploy", f));

/** Thrown for anything this script cannot read confidently. */
class ParseError extends Error {}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Remove shell comments, without touching a '#' inside a quoted string.
 *
 * This matters more than it looks. `update-agent.sh` discusses its own case
 * arms in the comments above them, and `cron-sign.sh` quotes the signing format
 * in prose. A naive scan would find those and "prove" a parity that the code
 * does not actually have — the matcher would be reading the documentation
 * rather than the program.
 *
 * Quote tracking is deliberately simple (single and double, with backslash
 * escapes outside single quotes) because that is all these scripts use. Anything
 * more exotic would be a reason to fail, not to guess.
 */
export function stripShellComments(src) {
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && quote === '"' && i + 1 < src.length) {
        out += src[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < src.length) {
      out += ch + src[++i];
      continue;
    }
    if (ch === "#") {
      // A '#' only starts a comment at the start of a word.
      const prev = out[out.length - 1];
      if (prev === undefined || /\s/.test(prev)) {
        while (i < src.length && src[i] !== "\n") i++;
        out += "\n";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Remove TypeScript line and block comments, leaving string and template
 * literals alone. The doc comment above `UPDATE_REQUESTS` describes the exact
 * payload shapes, so scanning the raw file would match the prose.
 */
export function stripTsComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < src.length) {
        out += src[++i];
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. UPDATE_REQUESTS  <->  update-agent.sh case arms
// ---------------------------------------------------------------------------

/** The three payload strings the app can write, from the TypeScript side. */
export function parseUpdateRequestLiterals(tsSource) {
  const src = stripTsComments(tsSource);
  const m = src.match(/export\s+const\s+UPDATE_REQUESTS\s*=\s*\{([\s\S]*?)\}\s*as\s+const\s*;/);
  if (!m) {
    throw new ParseError(
      "could not find `export const UPDATE_REQUESTS = { ... } as const;` in src/lib/update-request.ts.\n" +
        "  The shape changed. Fix this parser deliberately rather than letting it match nothing —\n" +
        "  an empty set would compare equal to an empty set and report parity that does not exist."
    );
  }
  const body = m[1];
  const literals = [];
  // Each entry is `key: '<payload>',` — the payloads contain double quotes, so
  // they are written with single quotes in the source.
  const entry = /(\w+)\s*:\s*(['"])((?:\\.|(?!\2).)*)\2/g;
  let e;
  while ((e = entry.exec(body)) !== null) {
    literals.push(e[3].replace(/\\(.)/g, "$1"));
  }
  if (literals.length === 0) {
    throw new ParseError("UPDATE_REQUESTS was found but no payload literals could be read from it.");
  }
  return literals;
}

/** The whole-string patterns the root-side agent will accept. */
export function parseAgentCaseArms(shSource) {
  const src = stripShellComments(shSource);
  const m = src.match(/case\s+"\$\{ACTION_RAW\}"\s+in([\s\S]*?)\besac\b/);
  if (!m) {
    throw new ParseError(
      'could not find `case "${ACTION_RAW}" in ... esac` in deploy/update-agent.sh.\n' +
        "  That case IS the closed set of accepted requests. Fix this parser deliberately."
    );
  }
  const body = m[1];
  const arms = [];
  // Arms are single-quoted because the payloads contain double quotes.
  const arm = /^\s*'([^']*)'\s*\)/gm;
  let a;
  while ((a = arm.exec(body)) !== null) arms.push(a[1]);
  if (arms.length === 0) {
    throw new ParseError("the case block was found but no literal arms could be read from it.");
  }
  return arms;
}

// ---------------------------------------------------------------------------
// 2. cronSigningString  <->  cron_signing_string
// ---------------------------------------------------------------------------

/**
 * Build a callable from the TypeScript template literal, without a TS compiler.
 *
 * The function is a single `return \`...\`;` over its four parameters plus the
 * version constant, so the template can be lifted out and evaluated directly.
 * That is the real expression, `.toUpperCase()` and all — not a restatement of
 * it, which would be one more thing to drift.
 */
export function buildTsSigner(tsSource) {
  const src = stripTsComments(tsSource);
  const verMatch = src.match(/export\s+const\s+CRON_SIGNATURE_VERSION\s*=\s*["']([^"']+)["']/);
  if (!verMatch) {
    throw new ParseError("could not read CRON_SIGNATURE_VERSION from src/lib/cron-auth.ts.");
  }
  const version = verMatch[1];

  const fn = src.match(/export\s+function\s+cronSigningString\s*\(([\s\S]*?)\)\s*:\s*string\s*\{([\s\S]*?)\n\}/);
  if (!fn) {
    throw new ParseError("could not find `export function cronSigningString(...)` in src/lib/cron-auth.ts.");
  }
  const body = fn[2];
  const tpl = body.match(/return\s+(`[\s\S]*?`)\s*;/);
  if (!tpl) {
    throw new ParseError(
      "cronSigningString is no longer a single template-literal return.\n" +
        "  This script evaluates that template to compare it with the shell. Rather than guess at a\n" +
        "  different shape, it stops — update the parser deliberately."
    );
  }

  // Parameter names, in order, with their type annotations dropped.
  const params = fn[1]
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split(":")[0].trim());

  const make = new Function(
    "CRON_SIGNATURE_VERSION",
    ...params,
    `return ${tpl[1]};`
  );
  return {
    version,
    params,
    sign: (...args) => make(version, ...args),
  };
}

/** Run the shell function exactly as the cron scripts do. */
export function shellSign(method, path, timestamp, nonce) {
  return execFileSync(
    "bash",
    [
      "-c",
      'set -u; source "$1"; cron_signing_string "$2" "$3" "$4" "$5"',
      "_",
      CRON_SIGN_SH,
      method,
      path,
      timestamp,
      nonce,
    ],
    { encoding: "utf8" }
  );
}

/** The (method, path) pairs the cron scripts actually sign, read from source. */
export function parseCronScriptCalls(path, source) {
  const src = stripShellComments(source);
  const calls = [];
  const re = /cron_sign_request\s+(\S+)\s+"?([^"\s]+)"?/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    calls.push({ file: path, method: m[1], path: m[2] });
  }
  const headers = [];
  const hre = /-H\s+"(X-Auto-[A-Za-z-]+):\s*true"/g;
  while ((m = hre.exec(src)) !== null) headers.push(m[1]);
  return { calls, headers };
}

/** The paths the proxy will treat as cron requests, and the header each needs. */
export function parseProxyCronPaths(tsSource) {
  const src = stripTsComments(tsSource);
  const m = src.match(/const\s+isCronRequest\s*=([\s\S]*?);\n/);
  if (!m) {
    throw new ParseError("could not find `const isCronRequest = ...` in src/proxy.ts.");
  }
  const out = [];
  const re =
    /pathname\s*===\s*"([^"]+)"\s*&&\s*request\.headers\.get\(\s*"([^"]+)"\s*\)\s*===\s*"true"/g;
  let e;
  while ((e = re.exec(m[1])) !== null) out.push({ path: e[1], header: e[2] });
  if (out.length === 0) {
    throw new ParseError("isCronRequest was found but no path/header pairs could be read from it.");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Self-tests — run on every invocation, like check-route-guards.mjs
// ---------------------------------------------------------------------------

const SELF_TESTS = [
  // The strippers must not be fooled by the file's own prose. Both of these are
  // modelled on text that really is in the files.
  {
    name: "shell stripper removes a comment that quotes a case arm",
    run: () => {
      const s = stripShellComments(
        `# matches '{"action":"update"}' exactly\ncase "\${ACTION_RAW}" in\n  '{"action":"real"}')\n ;;\nesac\n`
      );
      return !s.includes('"action":"update"') && s.includes('"action":"real"');
    },
  },
  {
    name: "shell stripper keeps a '#' inside a quoted string",
    run: () => stripShellComments(`X="a#b"\n`).includes("a#b"),
  },
  {
    name: "shell stripper keeps a mid-word '#'",
    run: () => stripShellComments("url=host#frag\n").includes("host#frag"),
  },
  {
    name: "ts stripper removes a doc comment quoting a payload",
    run: () => {
      const s = stripTsComments(
        `/** writes '{"action":"update"}' */\nconst x = '{"action":"real"}';\n`
      );
      return !s.includes('"action":"update"') && s.includes('"action":"real"');
    },
  },
  {
    name: "ts stripper keeps a '//' inside a string",
    run: () => stripTsComments(`const u = "https://x/y";\n`).includes("https://x/y"),
  },
  {
    name: "update-request parser reads the payloads",
    run: () => {
      const lits = parseUpdateRequestLiterals(
        `export const UPDATE_REQUESTS = {\n  a: '{"action":"one"}',\n  b: '{"action":"two"}',\n} as const;\n`
      );
      return lits.length === 2 && lits[0] === '{"action":"one"}';
    },
  },
  {
    name: "update-request parser refuses an unrecognised shape (does not return empty)",
    run: () => {
      try {
        parseUpdateRequestLiterals("export const SOMETHING_ELSE = {};");
        return false;
      } catch (e) {
        return e instanceof ParseError;
      }
    },
  },
  {
    name: "agent case parser reads the arms",
    run: () => {
      const arms = parseAgentCaseArms(
        `case "\${ACTION_RAW}" in\n    '{"action":"one"}')\n        :\n        ;;\n    *)\n        :\n        ;;\nesac\n`
      );
      return arms.length === 1 && arms[0] === '{"action":"one"}';
    },
  },
  {
    name: "agent case parser refuses an unrecognised shape",
    run: () => {
      try {
        parseAgentCaseArms("echo hello\n");
        return false;
      } catch (e) {
        return e instanceof ParseError;
      }
    },
  },
  {
    name: "ts signer evaluates the real template literal",
    run: () => {
      const s = buildTsSigner(
        'export const CRON_SIGNATURE_VERSION = "v9";\n' +
          "export function cronSigningString(\n  method: string,\n  pathname: string,\n  timestamp: string,\n  nonce: string\n): string {\n  return `${CRON_SIGNATURE_VERSION}:${method.toUpperCase()}:${pathname}:${timestamp}:${nonce}`;\n}\n"
      );
      return s.sign("post", "/p", "1", "n") === "v9:POST:/p:1:n";
    },
  },
  {
    name: "ts signer refuses a non-template-literal body",
    run: () => {
      try {
        buildTsSigner(
          'export const CRON_SIGNATURE_VERSION = "v1";\n' +
            "export function cronSigningString(a: string): string {\n  return a.split(':').join('-');\n}\n"
        );
        return false;
      } catch (e) {
        return e instanceof ParseError;
      }
    },
  },
  {
    name: "cron script parser reads the call and the header",
    run: () => {
      const r = parseCronScriptCalls("x", 'cron_sign_request POST "/api/a/b"\ncurl -H "X-Auto-Thing: true" \\\n');
      return r.calls.length === 1 && r.calls[0].path === "/api/a/b" && r.headers[0] === "X-Auto-Thing";
    },
  },
  {
    name: "proxy cron parser reads path/header pairs",
    run: () => {
      const p = parseProxyCronPaths(
        'const isCronRequest =\n  (pathname === "/api/a" &&\n    request.headers.get("x-auto-a") === "true");\n'
      );
      return p.length === 1 && p[0].path === "/api/a" && p[0].header === "x-auto-a";
    },
  },
  {
    name: "proxy cron parser refuses an unrecognised shape",
    run: () => {
      try {
        parseProxyCronPaths("const somethingElse = true;\n");
        return false;
      } catch (e) {
        return e instanceof ParseError;
      }
    },
  },
];

function runSelfTests() {
  const failures = [];
  for (const t of SELF_TESTS) {
    let ok = false;
    try {
      ok = t.run() === true;
    } catch (err) {
      failures.push(`${t.name} — threw: ${err.message}`);
      continue;
    }
    if (!ok) failures.push(t.name);
  }
  if (failures.length) {
    console.error(`\n${failures.length} self-test failure(s) in this script:\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      "\nThe check itself is broken, so its verdict on the repository means nothing.\n"
    );
    process.exit(1);
  }
  return SELF_TESTS.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const selfTestCount = runSelfTests();

const problems = [];
const notes = [];

function read(path) {
  if (!existsSync(path)) {
    console.error(`\nERROR: ${path} does not exist. This check cannot run.\n`);
    process.exit(1);
  }
  return readFileSync(path, "utf8");
}

// --- 1. update request literals ---------------------------------------------
try {
  const appSide = parseUpdateRequestLiterals(read(UPDATE_REQUEST_TS));
  const agentSide = parseAgentCaseArms(read(UPDATE_AGENT_SH));

  const missingInAgent = appSide.filter((l) => !agentSide.includes(l));
  const missingInApp = agentSide.filter((l) => !appSide.includes(l));

  for (const l of missingInAgent) {
    problems.push(
      `UPDATE_REQUESTS payload ${JSON.stringify(l)} has no matching case arm in deploy/update-agent.sh.\n` +
        `    The app would write this and the agent would reject it as unrecognised — the update simply never happens.`
    );
  }
  for (const l of missingInApp) {
    problems.push(
      `deploy/update-agent.sh accepts ${JSON.stringify(l)}, which no longer appears in UPDATE_REQUESTS.\n` +
        `    Either the app stopped writing it (remove the arm) or a payload was renamed on one side only.`
    );
  }
  notes.push(`update requests: ${appSide.length} payload(s) matched across the boundary`);
} catch (err) {
  problems.push(`update-request parity could not be checked: ${err.message}`);
}

// --- 2. cron signing string --------------------------------------------------
let signer = null;
try {
  signer = buildTsSigner(read(CRON_AUTH_TS));
  const shVersion = read(CRON_SIGN_SH).match(/^CRON_SIGNATURE_VERSION="([^"]+)"/m);
  if (!shVersion) {
    problems.push("could not read CRON_SIGNATURE_VERSION from deploy/lib/cron-sign.sh.");
  } else if (shVersion[1] !== signer.version) {
    problems.push(
      `cron signature version differs: TypeScript says ${JSON.stringify(signer.version)}, ` +
        `deploy/lib/cron-sign.sh says ${JSON.stringify(shVersion[1])}.\n` +
        `    Every scheduled job would 401.`
    );
  }

  // Vectors chosen to catch each realistic drift: separator, field order, field
  // count, and values containing the separator itself.
  const vectors = [
    ["POST", "/api/admin/backup/save", "1700000000", "0123456789abcdef0123456789abcdef"],
    ["POST", "/api/admin/scheduled-exports/execute", "1", "ff"],
    ["POST", "/api/admin/scheduled-exports/credentials/check", "1700000001", "abc"],
    ["GET", "/api/x", "0", "n"],
    ["POST", "/api/a:b/c", "123", "de:ad"],
  ];
  for (const [method, path, ts, nonce] of vectors) {
    const fromTs = signer.sign(method, path, ts, nonce);
    const fromSh = shellSign(method, path, ts, nonce);
    if (fromTs !== fromSh) {
      problems.push(
        `cron signing string differs for (${method}, ${path}):\n` +
          `      TypeScript: ${JSON.stringify(fromTs)}\n` +
          `      shell:      ${JSON.stringify(fromSh)}\n` +
          `    The HMACs will not match and every scheduled job returns 401.`
      );
      break;
    }
  }
  notes.push(`cron signing: ${vectors.length} vector(s) produced byte-identical strings`);
} catch (err) {
  problems.push(`cron signing parity could not be checked: ${err.message}`);
}

// --- 3. the cron triangle: script -> proxy ----------------------------------
try {
  const proxyPairs = parseProxyCronPaths(read(PROXY_TS));
  const proxyByPath = new Map(proxyPairs.map((p) => [p.path, p.header.toLowerCase()]));
  let callCount = 0;

  for (const scriptPath of CRON_SCRIPTS) {
    const rel = scriptPath.slice(ROOT.length + 1);
    const { calls, headers } = parseCronScriptCalls(rel, read(scriptPath));
    if (calls.length === 0) {
      problems.push(`${rel} signs no request — cron_sign_request could not be found in it.`);
      continue;
    }
    for (const call of calls) {
      callCount++;
      // The TypeScript side uppercases the method and the shell side does not,
      // so the two agree only while every caller passes an uppercase method.
      // That is true today; this is what keeps it true.
      if (call.method !== call.method.toUpperCase()) {
        problems.push(
          `${rel} signs with method ${JSON.stringify(call.method)}.\n` +
            `    cronSigningString uppercases the method and cron_signing_string does not, so a\n` +
            `    lowercase method makes the two sides sign different strings and the job 401s.`
        );
      }
      if (!proxyByPath.has(call.path)) {
        problems.push(
          `${rel} signs ${call.path}, which is not in src/proxy.ts's isCronRequest list.\n` +
            `    The proxy would never run the signature check, so the request falls through to JWT\n` +
            `    auth and 401s — a failure that reads like a credentials problem. This is exactly how\n` +
            `    the daily credential check silently never ran.`
        );
        continue;
      }
      const wanted = proxyByPath.get(call.path);
      const sent = headers.map((h) => h.toLowerCase());
      if (!sent.includes(wanted)) {
        problems.push(
          `${rel} signs ${call.path} but does not send the ${wanted} header the proxy requires.\n` +
            `    Sent: ${sent.length ? sent.join(", ") : "(none)"}. The proxy gates on path AND header.`
        );
      }
    }
  }
  notes.push(`cron triangle: ${callCount} signed call(s) matched a proxy path and header`);
} catch (err) {
  problems.push(`cron triangle could not be checked: ${err.message}`);
}

// --- verdict -----------------------------------------------------------------
if (problems.length) {
  console.error(`\n${problems.length} deploy/app parity problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  console.error(
    "These are the invariants CLAUDE.md marks as must-never-drift. Each failure mode is\n" +
      "silent in production: the update never happens, or every scheduled job 401s.\n"
  );
  process.exit(1);
}

console.log(`deploy/app parity OK (${selfTestCount} self-tests passed)`);
for (const n of notes) console.log(`  - ${n}`);
