/**
 * Write-side schema for `ExportCredential.config`.
 *
 * `config` is an untyped JSON blob, and the routes that write it are
 * `requireAuth("Admin")` rather than SuperAdmin — `/api/admin/scheduled-exports`
 * is deliberately not in the proxy's `SUPER_ADMIN_PREFIXES`, so a company Admin
 * scoped to a single company reaches them, while `ExportCredential` itself has
 * no company dimension at all. The blob then reaches real sinks: `host`/`port`
 * become an outbound TCP connection this server opens, and `tenantId` is
 * interpolated into a provider URL *before* `new URL` parses it, where a `/`,
 * `?`, `#` or `..` reshapes the request path and query rather than being a
 * value inside it.
 *
 * The read side already had an allowlist (`publicKeys`, added when a denylist
 * was found to fail open); this is the matching write side, so a key that is
 * not classified in the table below cannot be stored at all.
 *
 * `PROVIDER_FIELDS` lives here rather than in the route so that the read
 * allowlist, the blank-means-keep secret list and the write schema are one
 * declaration. A key in exactly one of them is precisely the drift this is
 * meant to prevent.
 *
 * Deliberately not attempted here: deciding *which* hosts are acceptable. The
 * rules below bound the shape of a value, not its destination — an internal
 * relay on a private address is a legitimate mail configuration, so a
 * destination policy belongs at the network layer, not in a text field check.
 */

/** How each key an `ExportCredential.config` may hold is classified. */
export interface ProviderFieldSpec {
  /** Returned verbatim by GET. The whole of what the client may read back. */
  publicKeys: string[];
  /** Never returned; only their presence is reported. Blank on write = keep. */
  secretKeys: string[];
  /**
   * Written by the server itself (the OAuth start route), never accepted from
   * a client and never returned by GET. Listed so the table stays a complete
   * inventory of what a stored blob may contain — leaving them unlisted is
   * what would make a later "validate the OAuth writes too" change silently
   * reject a working flow.
   */
  internalKeys: string[];
}

export const PROVIDER_FIELDS: Record<string, ProviderFieldSpec> = {
  email: {
    publicKeys: ["host", "port", "secure", "allowInsecureTls", "user", "from"],
    secretKeys: ["password"],
    internalKeys: [],
  },
  "google-drive": {
    publicKeys: ["folderId"],
    secretKeys: ["clientId", "clientSecret", "refreshToken", "accessToken"],
    internalKeys: ["pending", "previousRefreshToken"],
  },
  box: {
    publicKeys: ["folderId"],
    secretKeys: ["clientId", "clientSecret", "refreshToken", "accessToken"],
    internalKeys: ["pending", "previousRefreshToken"],
  },
  onedrive: {
    publicKeys: ["folderPath", "tenantId"],
    secretKeys: ["clientId", "clientSecret", "refreshToken", "accessToken"],
    internalKeys: ["pending", "previousRefreshToken"],
  },
};

export const VALID_PROVIDERS = Object.keys(PROVIDER_FIELDS);

/** An unknown provider cannot reach the write paths, but read defensively. */
export function fieldsFor(provider: string): ProviderFieldSpec {
  return PROVIDER_FIELDS[provider] ?? { publicKeys: [], secretKeys: [], internalKeys: [] };
}

// ─── Primitive shape checks ──────────────────────────────────────────────────

/**
 * A single DNS label, 1–63 chars.
 *
 * Deliberately more permissive than the letter of RFC 1035: an **underscore**
 * is allowed anywhere in the label. Underscored names are common in practice
 * for internal mail hosts, and this check is about shape, not reachability —
 * refusing one would mean a working credential could not be re-saved without
 * changing the host, which the operator would discover while editing something
 * else entirely. Hyphens still may not start or end a label.
 */
const HOSTNAME_LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;

/**
 * Tenant IDs are a GUID or a verified domain — both fit this alphabet.
 *
 * `.` and `..` fit it too and are excluded separately in `isValidTenantId`:
 * they are not identifiers, and `new URL` resolves them away, silently turning
 * the tenant path segment into a different endpoint.
 */
const TENANT_ID = /^[A-Za-z0-9._-]{1,128}$/;

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every(
    // A leading zero would be read as octal by some resolvers, so reject it
    // rather than store a value whose meaning depends on who parses it.
    (p) => /^\d{1,3}$/.test(p) && !(p.length > 1 && p.startsWith("0")) && Number(p) <= 255,
  );
}

function isIpv6(value: string): boolean {
  const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const halves = inner.split("::");
  if (halves.length > 2) return false; // at most one run of zeroes may be elided
  const compressed = halves.length === 2;
  const groups = [...split(halves[0]), ...(compressed ? split(halves[1]) : [])];

  // A trailing IPv4 literal (e.g. ::ffff:192.0.2.1) stands for two groups.
  let count = groups.length;
  if (groups.length > 0 && isIpv4(groups[groups.length - 1])) {
    groups.pop();
    count += 1;
  }
  if (!groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  return compressed ? count < 8 : count === 8;

  function split(part: string): string[] {
    return part === "" ? [] : part.split(":");
  }
}

function isHostname(value: string): boolean {
  if (value.length > 254) return false;
  // A single trailing dot is a fully-qualified name ("smtp.example.com."), which
  // resolvers accept and some operators write. Strip one before splitting, or
  // the empty last label fails every time.
  const name = value.endsWith(".") ? value.slice(0, -1) : value;
  if (name === "" || name.length > 253) return false;
  return name.split(".").every((label) => HOSTNAME_LABEL.test(label));
}

/** A syntactically valid hostname or IP literal — shape only, see the header. */
export function isValidHost(value: string): boolean {
  return isHostname(value) || isIpv4(value) || isIpv6(value);
}

/**
 * Tenant ID shape check, exported because the OAuth start route takes the same
 * value by a different door and must apply the same rule.
 */
export function tenantIdProblem(value: string): string | null {
  // `.` and `..` pass the alphabet but are path navigation, not identifiers:
  // `new URL` resolves the segment away, so the request lands on a different
  // endpoint of the same host than the template describes. They get their own
  // message, because telling someone who typed ".." that only dots are allowed
  // is not a description of the rule that rejected them.
  if (value === "." || value === "..") {
    return "Tenant ID must be a tenant name or ID, not a path segment.";
  }
  if (!TENANT_ID.test(value)) {
    return "Tenant ID may contain only letters, digits, dots, hyphens and underscores.";
  }
  return null;
}

/** Convenience predicate over {@link tenantIdProblem}. */
export function isValidTenantId(value: string): boolean {
  return tenantIdProblem(value) === null;
}

// ─── Per-key rules ───────────────────────────────────────────────────────────

type FieldResult = { value: unknown } | { error: string };

/** Longest an ordinary field may be. Each named field sets a tighter one. */
const MAX_VALUE_LENGTH = 4096;

/**
 * Tokens get their own, much larger ceiling.
 *
 * These are not values an admin types — they are issued by the provider, and a
 * Microsoft refresh token can plausibly exceed 4 KB. The cap also applies to
 * values the blank-means-keep merge pulls out of the *stored* blob, so one that
 * is too low rejects the save of an unrelated field, and rejects the OAuth start
 * route's `previousRefreshToken` — which is the "Connect with..." click that
 * would have repaired the credential. Keep the tight cap for fields where a long
 * value really is nonsense (host, port, user, from, tenantId) and be generous
 * here.
 */
const MAX_TOKEN_LENGTH = 16384;

const TOKEN_KEYS = new Set(["refreshToken", "previousRefreshToken", "accessToken"]);

/**
 * Keys stored byte-for-byte, never trimmed.
 *
 * A password or token is an opaque string chosen elsewhere: trailing whitespace
 * in it is data, not formatting. This matters more than it sounds, because the
 * post-merge pass re-validates values pulled from the stored blob — so a trim
 * there silently rewrites a secret nobody submitted, during a save of an
 * unrelated field, and the resulting failure reads as an authentication problem.
 *
 * The post-merge pass itself stays: it is what checks the *whole* object that
 * gets sealed, including a value stored before this schema existed. What it must
 * not do is edit a value the request did not carry.
 */
const VERBATIM_KEYS = new Set([
  "password",
  "clientId",
  "clientSecret",
  "refreshToken",
  "previousRefreshToken",
  "accessToken",
]);

function plainString(
  value: unknown,
  label: string,
  maxLength = MAX_VALUE_LENGTH,
  trim = true,
): FieldResult {
  if (typeof value !== "string") return { error: `${label} must be text.` };
  const trimmed = trim ? value.trim() : value;
  if (trimmed.length > maxLength) return { error: `${label} is too long.` };
  // Control characters would ride into a header, a URL or an SMTP command.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { error: `${label} contains characters that are not allowed.` };
  }
  return { value: trimmed };
}

function booleanValue(value: unknown, label: string): FieldResult {
  if (typeof value !== "boolean") return { error: `${label} must be on or off.` };
  return { value };
}

/**
 * Per-key rules, keyed on the field name rather than on provider+field: a name
 * means the same thing wherever it appears, and one table is easier to keep
 * true than four.
 *
 * Messages name the field but never echo the submitted value back, and avoid
 * the words `isAuthError` keys on (see `lib/credential-health.ts`) so a
 * validation message can never be mistaken for a provider auth failure.
 */
const FIELD_RULES: Record<string, (value: unknown) => FieldResult> = {
  host: (value) => {
    const text = plainString(value, "SMTP host", 253);
    if ("error" in text) return text;
    if (!isValidHost(text.value as string)) {
      return { error: "SMTP host must be a hostname or an IP address." };
    }
    return text;
  },

  // The form posts this as a string, so coerce rather than reject.
  port: (value) => {
    if (typeof value !== "string" && typeof value !== "number") {
      return { error: "Port must be a number." };
    }
    const text = String(value).trim();
    if (!/^\d{1,5}$/.test(text)) return { error: "Port must be a whole number between 1 and 65535." };
    const port = Number(text);
    if (port < 1 || port > 65535) return { error: "Port must be a whole number between 1 and 65535." };
    return { value: port };
  },

  secure: (value) => booleanValue(value, "Implicit SSL/TLS"),
  allowInsecureTls: (value) => booleanValue(value, "Allow self-signed certificate"),
  pending: (value) => booleanValue(value, "Connection state"),

  user: (value) => plainString(value, "Username", 320),
  from: (value) => plainString(value, "From address", 320),

  tenantId: (value) => {
    const text = plainString(value, "Tenant ID", 128);
    if ("error" in text) return text;
    const problem = tenantIdProblem(text.value as string);
    return problem ? { error: problem } : text;
  },

  folderId: (value) => plainString(value, "Folder ID", 256),
  folderPath: (value) => plainString(value, "Folder path", 1024),
};

/**
 * Anything classified in the table but without a rule of its own — in practice
 * the secrets and tokens, which have no structure to check beyond "opaque text
 * of a plausible length".
 */
function defaultRule(key: string, value: unknown): FieldResult {
  return plainString(
    value,
    labelFor(key),
    TOKEN_KEYS.has(key) ? MAX_TOKEN_LENGTH : MAX_VALUE_LENGTH,
    !VERBATIM_KEYS.has(key),
  );
}

function labelFor(key: string): string {
  switch (key) {
    case "password":
      return "Password";
    case "clientId":
      return "Client ID";
    case "clientSecret":
      return "Client secret";
    case "refreshToken":
    case "previousRefreshToken":
    case "accessToken":
      return "Stored token";
    default:
      return "Value";
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export interface ValidateOptions {
  /**
   * Allow the server-written keys (`pending`, `previousRefreshToken`). Only the
   * OAuth start route sets this; a client-supplied body never may.
   */
  allowInternal?: boolean;
}

/**
 * Validate and normalise a credential config before it is sealed.
 *
 * Return shape follows `normaliseLocalExportConfig` in `lib/export-destinations.ts`:
 * either the usable value or `{ error }`, so callers branch on `"error" in result`.
 *
 * An empty string is treated as "not provided" and dropped rather than stored.
 * That is already the contract for secrets (blank means keep the stored one)
 * and it keeps every other field optional, so this adds format checking without
 * making a previously-savable credential unsavable.
 */
export function validateCredentialConfig(
  provider: string,
  config: unknown,
  options: ValidateOptions = {},
): { config: Record<string, unknown> } | { error: string } {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    // `typeof [] === "object"`, which is how an array used to be spread into
    // an object with numeric keys and sealed.
    return { error: "Credential settings must be an object." };
  }

  const spec = fieldsFor(provider);
  const allowed = new Set([
    ...spec.publicKeys,
    ...spec.secretKeys,
    ...(options.allowInternal ? spec.internalKeys : []),
  ]);

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      // Do not name the key: it is attacker-controlled text on this path.
      return { error: "Credential settings contain an entry that is not recognised for this provider." };
    }

    const raw = (config as Record<string, unknown>)[key];
    // "Not provided" is decided here, once, for every key — including the
    // verbatim ones, which are not trimmed later and so would otherwise store a
    // field an admin left as whitespace instead of keeping what is already
    // there. A value with any real content is passed through untouched.
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "string" && raw.trim() === "") continue;

    const rule = FIELD_RULES[key];
    const result = rule ? rule(raw) : defaultRule(key, raw);
    if ("error" in result) return result;
    if (result.value === "") continue;
    out[key] = result.value;
  }

  return { config: out };
}
