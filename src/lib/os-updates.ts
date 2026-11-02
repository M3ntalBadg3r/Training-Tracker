/**
 * Is this host applying its operating system's own security updates?
 *
 * Training Tracker's updates cover the app and (through the deploy layer's
 * Node.js floor) the Node runtime. Everything else on the server — PostgreSQL,
 * system OpenSSL, ca-certificates, the kernel — comes from the distribution,
 * whose security fixes arrive through its own channel. On Debian/Ubuntu that is
 * unattended-upgrades. `deploy/install.sh` offers to turn it on; this module is
 * how Admin › Updates tells an operator whether it is actually on, since boxes
 * installed before that, or whose operator declined, are otherwise silent.
 *
 * ## Why it parses apt's files instead of asking apt
 *
 * `apt-config dump` is the authoritative answer, and the root-side install step
 * uses it. The app does not: `src/` contains no shell execution at all, by rule
 * (see CLAUDE.md, Deployment → Cron), and a status line is not a reason to break
 * it. So this reads the same files apt reads, in the order apt reads them, with
 * a small parser for apt's configuration syntax. Where that parser could be
 * wrong it errs towards reporting "on" (an unparseable file is skipped, not
 * treated as switching anything off), because a false "off" warning on a
 * correctly patched host trains the operator to ignore the notice.
 *
 * The rules mirror `/usr/lib/apt/apt.systemd.daily`, which is what actually
 * runs the upgrades:
 *   - `APT::Periodic::Enable "0"` switches off every periodic apt job;
 *   - `APT::Periodic::Unattended-Upgrade` must be set and not "0";
 *   - `APT::Periodic::Update-Package-Lists` must be set and not "0" — upgrades
 *     run against stale package lists would never see a new fix;
 *   - on a systemd host, `apt-daily.timer` and `apt-daily-upgrade.timer` must be
 *     enabled and not masked. (Without systemd, cron.daily runs them.)
 *
 * Server-only (`node:fs`). It imports nothing from the app, so it can be driven
 * directly against fixture directories.
 *
 * Every `fs` call carries `/*turbopackIgnore: true*\/`. Turbopack traces
 * filesystem calls to decide which files the server bundle needs, and a path it
 * cannot resolve statically (these take overridable paths, for the fixtures)
 * makes it trace the WHOLE project and print a warning on every build — noise in
 * `.update-log`, the file an operator reads when an update fails. These paths
 * are system files outside the project, so there is nothing to trace.
 */

import fs from "node:fs";
import path from "node:path";

export type OsUpdatesReason =
  | "notInstalled"
  | "periodicDisabled"
  | "upgradesOff"
  | "listsOff"
  | "timerOff";

export type OsUpdatesStatus =
  | { status: "on" }
  | { status: "off"; reason: OsUpdatesReason }
  /** Not an apt-based system: nothing to report. */
  | { status: "unsupported" }
  /** The configuration could not be read. */
  | { status: "unknown" };

/** Where to look. Overridable for fixture tests; production uses the defaults. */
export interface OsUpdatesPaths {
  aptEtc: string;
  unattendedBinary: string;
  systemdRun: string;
  systemdEtc: string;
}

const DEFAULT_PATHS: OsUpdatesPaths = {
  aptEtc: "/etc/apt",
  unattendedBinary: "/usr/bin/unattended-upgrade",
  systemdRun: "/run/systemd/system",
  systemdEtc: "/etc/systemd/system",
};

/** No apt configuration file is anywhere near this size; a larger one is skipped. */
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIG_FILES = 500;

/**
 * Parse apt configuration text into `into` (keys lower-cased, as apt matches
 * them case-insensitively; a later assignment overwrites an earlier one, as in
 * apt). Handles the flat form (`APT::Periodic::Enable "1";`) and the nested
 * block form (`APT { Periodic { Enable "1"; }; };`). List entries, `#clear` /
 * `#include` directives and anything unexpected are skipped rather than
 * guessed at.
 */
export function parseAptConfig(text: string, into: Map<string, string>): void {
  const tokens = tokenizeAptConfig(text);
  const scope: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === "}") {
      scope.pop();
      i++;
      if (tokens[i] === ";") i++;
      continue;
    }
    if (tok === ";" || tok === "{" || tok.startsWith('"')) {
      // A stray separator, an anonymous block, or a bare list entry.
      i++;
      continue;
    }
    const key = tok;
    const next = tokens[i + 1];
    if (next === "{") {
      scope.push(key);
      i += 2;
      continue;
    }
    if (next !== undefined && next.startsWith('"')) {
      into.set([...scope, key].join("::").toLowerCase(), next.slice(1));
      i += 2;
      continue;
    }
    i++;
  }
}

/**
 * Split apt configuration into tokens: `{`, `}`, `;`, bare words, and quoted
 * values (returned with a leading `"` so they cannot be mistaken for words).
 *
 * A character scanner rather than a regex pre-pass that strips comments first,
 * and the difference is load-bearing: comment stripping must not look inside a
 * string. `Acquire::http::Proxy "http://proxy:3128";` is ordinary on a host
 * behind a proxy, and stripping `//` from it truncates the line, leaves an
 * unterminated quote, and swallows the rest of the file into one bogus value.
 * An unterminated quote here stops the file rather than guessing.
 */
function tokenizeAptConfig(text: string): string[] {
  const tokens: string[] = [];
  const n = text.length;
  const skipToEol = (from: number) => {
    const eol = text.indexOf("\n", from);
    return eol < 0 ? n : eol;
  };
  let i = 0;
  let lineStart = true;
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      lineStart = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === '"') {
      const close = text.indexOf('"', i + 1);
      if (close < 0) break;
      tokens.push('"' + text.slice(i + 1, close));
      i = close + 1;
      lineStart = false;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i = skipToEol(i);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (c === "#" && lineStart) {
      // A comment, or a #clear / #include directive: neither sets a value.
      i = skipToEol(i);
      continue;
    }
    if (c === "{" || c === "}" || c === ";") {
      tokens.push(c);
      i++;
      lineStart = false;
      continue;
    }
    let j = i;
    while (
      j < n &&
      !/[\s{};"]/.test(text[j]) &&
      !(text[j] === "/" && (text[j + 1] === "/" || text[j + 1] === "*"))
    ) {
      j++;
    }
    tokens.push(text.slice(i, j));
    i = j;
    lineStart = false;
  }
  return tokens;
}

/** The files apt reads, in the order it reads them: apt.conf.d, then apt.conf. */
function aptConfigFiles(aptEtc: string): string[] {
  const files: string[] = [];
  const partsDir = path.join(aptEtc, "apt.conf.d");
  let names: string[] = [];
  try {
    names = fs.readdirSync(/*turbopackIgnore: true*/ partsDir);
  } catch {
    names = [];
  }
  // apt reads only names made of [A-Za-z0-9_.-] with no extension or ".conf",
  // in byte order — so "20auto-upgrades.dpkg-old" and "x.bak" are ignored.
  names
    .filter((n) => /^[A-Za-z0-9_.-]+$/.test(n) && (!n.includes(".") || n.endsWith(".conf")))
    .sort()
    .slice(0, MAX_CONFIG_FILES)
    .forEach((n) => files.push(path.join(partsDir, n)));
  files.push(path.join(aptEtc, "apt.conf"));
  return files;
}

function readConfig(aptEtc: string): Map<string, string> {
  const config = new Map<string, string>();
  for (const file of aptConfigFiles(aptEtc)) {
    try {
      const st = fs.statSync(/*turbopackIgnore: true*/ file);
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) continue;
      parseAptConfig(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"), config);
    } catch {
      // Missing or unreadable: skipped, never treated as switching anything off.
    }
  }
  return config;
}

const isOn = (value: string | undefined) => value !== undefined && value !== "" && value !== "0";

function timerUsable(systemdEtc: string, timer: string): boolean {
  // Masked: a unit file in /etc/systemd/system pointing at /dev/null.
  try {
    if (fs.readlinkSync(/*turbopackIgnore: true*/ path.join(systemdEtc, timer)) === "/dev/null") return false;
  } catch {
    // Not a symlink, or absent: not masked.
  }
  // Enabled: linked into timers.target.wants.
  try {
    fs.lstatSync(/*turbopackIgnore: true*/ path.join(systemdEtc, "timers.target.wants", timer));
    return true;
  } catch {
    return false;
  }
}

export function readOsUpdatesStatus(paths: OsUpdatesPaths = DEFAULT_PATHS): OsUpdatesStatus {
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ paths.aptEtc)) return { status: "unsupported" };
    if (!fs.existsSync(/*turbopackIgnore: true*/ paths.unattendedBinary)) return { status: "off", reason: "notInstalled" };

    const config = readConfig(paths.aptEtc);
    if (config.get("apt::periodic::enable") === "0") {
      return { status: "off", reason: "periodicDisabled" };
    }
    if (!isOn(config.get("apt::periodic::unattended-upgrade"))) {
      return { status: "off", reason: "upgradesOff" };
    }
    if (!isOn(config.get("apt::periodic::update-package-lists"))) {
      return { status: "off", reason: "listsOff" };
    }
    if (fs.existsSync(/*turbopackIgnore: true*/ paths.systemdRun)) {
      for (const timer of ["apt-daily.timer", "apt-daily-upgrade.timer"]) {
        if (!timerUsable(paths.systemdEtc, timer)) return { status: "off", reason: "timerOff" };
      }
    }
    return { status: "on" };
  } catch {
    return { status: "unknown" };
  }
}
