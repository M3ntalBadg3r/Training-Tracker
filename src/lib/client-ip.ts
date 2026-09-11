/**
 * Client-address attribution primitives, shared by the code that *performs*
 * the attribution (`lib/rate-limit.ts:getClientIp`) and the code that
 * *describes* it at boot (`src/instrumentation.ts`).
 *
 * They live here rather than in `rate-limit.ts` for one reason: the boot check
 * must not import Prisma, and `rate-limit.ts` does. But they must not be two
 * implementations either — a boot note that reports a different trusted set
 * from the one the limiter actually uses is worse than no note at all, and
 * that is exactly what happened when `instrumentation.ts` classified entries
 * with a bare `net.isIP` while `getClientIp` used `normaliseIp`: the two
 * disagreed about a blank value, an entry with a `:port`, and an IPv6 zone id.
 * One module, one answer, both callers.
 *
 * Deliberately dependency-free apart from `node:net`. Import it from
 * `instrumentation.ts` **dynamically, inside the `NEXT_RUNTIME === "nodejs"`
 * guard** — a static import there makes Turbopack emit an "Ecmascript file had
 * an error" warning for the edge build of the instrumentation hook, which then
 * appears in every customer's update log on every successful update.
 */

import net from "node:net";

/** Used when TRUSTED_PROXIES is unset, blank, or only whitespace. */
export const DEFAULT_TRUSTED_PROXIES = "127.0.0.1,::1";

/**
 * Canonical form of an IP literal, or null when the token is not one.
 *
 * IPv6 has many spellings for one address (`::1`, `0:0:0:0:0:0:0:1`), and the
 * trusted-proxy list is matched by exact string comparison — so without this a
 * proxy listed one way but presenting itself the other way is simply not
 * trusted, silently. Both sides of the comparison go through here, so the
 * spelling stops mattering. The WHATWG URL parser is the canonicaliser (it
 * implements the IPv6 serializer); IPv4 literals are already canonical, and
 * anything else — including CIDR ranges, which are **not** supported — is
 * rejected outright.
 *
 * **This function must be total.** Its inputs are attacker-supplied header
 * values, reached from eleven call sites on paths that answer unauthenticated
 * requests, so one throw turns a 401 into a 500 for anyone who can set a
 * header. `net.isIP` and `new URL` disagree about IPv6 zone ids
 * (`fe80::1%eth0`): isIP accepts them, the URL parser rejects them and throws.
 * Zone ids are link-local scope identifiers and can never be a client address
 * arriving over the network, so they are refused before the parser sees them —
 * and the parse is wrapped anyway, because "these two validators agree on
 * every other input" is not something to bet a 500 on. Verified total by
 * differential fuzzing; keep it that way.
 *
 * The `::ffff:` caveat: an IPv4-mapped address canonicalises to its IPv6 form
 * (`::ffff:127.0.0.1` → `::ffff:7f00:1`), so it still does not match a plain
 * `127.0.0.1` entry. List both spellings if a proxy presents the mapped form.
 */
export function normaliseIp(value: string): string | null {
  let token = value.trim();
  if (!token) return null;

  // Some proxies append a port: "1.2.3.4:5678" or "[2001:db8::1]:5678".
  if (token.startsWith("[")) {
    const end = token.indexOf("]");
    if (end > 0) token = token.slice(1, end);
  } else if (token.split(":").length === 2) {
    token = token.slice(0, token.indexOf(":"));
  }

  // See above: accepted by net.isIP, rejected by the URL parser.
  if (token.includes("%")) return null;

  const family = net.isIP(token);
  if (family === 4) return token;
  if (family !== 6) return null;
  try {
    // `hostname` comes back bracketed for IPv6; strip the brackets back off.
    return new URL(`http://[${token}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

export interface TrustedProxies {
  /** Canonicalised addresses whose X-Forwarded-For entries are stripped. */
  addresses: Set<string>;
  /** Entries that are not IP literals — named in a warning, never matched. */
  invalid: string[];
  /** True when the default list is in force because no usable value was given. */
  usingDefault: boolean;
}

/**
 * Resolve TRUSTED_PROXIES into the exact set `getClientIp` will match against.
 *
 * A blank or whitespace-only value falls back to the loopback default rather
 * than trusting nothing. Trusting nothing is the more dangerous reading: the
 * rightmost hop is then the proxy's own address, returned as "the client" for
 * everybody behind it — the single-shared-bucket collapse this whole area
 * exists to avoid — and a loopback source can never be a remote client anyway,
 * so the fallback cannot widen what is trusted in any meaningful sense.
 */
export function resolveTrustedProxies(raw: string | undefined): TrustedProxies {
  const trimmed = raw?.trim();
  const usingDefault = !trimmed;
  const effective = trimmed || DEFAULT_TRUSTED_PROXIES;

  const addresses = new Set<string>();
  const invalid: string[] = [];
  for (const entry of effective.split(",")) {
    const token = entry.trim();
    if (!token) continue;
    const canonical = normaliseIp(token);
    if (canonical) addresses.add(canonical);
    else invalid.push(token);
  }

  return { addresses, invalid, usingDefault };
}
