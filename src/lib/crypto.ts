/**
 * Symmetric envelope encryption for secrets at rest.
 *
 * Used to protect:
 *   - User.mfaSecret (TOTP shared secret)
 *   - ExportCredential.config (OAuth refresh tokens, SMTP passwords, client secrets)
 *
 * Format
 * ------
 * Encrypted blobs are self-describing strings of the form:
 *   "enc:v1:<base64(iv|authTag|ciphertext)>"
 *
 * The leading "enc:v1:" tag lets us tell encrypted from legacy plaintext at a
 * glance, which keeps the read paths backward-compatible during rollout: reads
 * decrypt encrypted blobs and pass plaintext through untouched, while writes
 * always encrypt (when ENCRYPTION_KEY is configured). Use the migration
 * endpoint at /api/admin/security/encrypt-secrets after upgrading to convert
 * any legacy rows.
 *
 * Configuration
 * -------------
 * ENCRYPTION_KEY must be a 64-character hex string (32 bytes) — generate with
 * `openssl rand -hex 32`. If unset, encrypt() throws and decrypt() of an
 * encrypted blob throws, which intentionally fails closed in production. For
 * compatibility in pre-upgrade environments, isEncryptionConfigured() lets
 * callers fall back to plaintext when the key is not yet provisioned.
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard
const TAG_LENGTH = 16;
const ENC_PREFIX = "enc:v1:";

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is required to encrypt/decrypt secrets at rest. Generate with: openssl rand -hex 32"
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

export function isEncryptionConfigured(): boolean {
  const hex = process.env.ENCRYPTION_KEY;
  return !!hex && /^[0-9a-fA-F]{64}$/.test(hex);
}

export function isEncryptedBlob(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/** Encrypt a UTF-8 string. Throws if ENCRYPTION_KEY is not set. */
export function encryptString(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, authTag, ciphertext]).toString("base64");
  return `${ENC_PREFIX}${blob}`;
}

/** Decrypt a string previously produced by encryptString. */
export function decryptString(blob: string): string {
  if (!isEncryptedBlob(blob)) {
    throw new Error("decryptString called on a value that is not an encrypted blob");
  }
  const key = getKey();
  const buf = Buffer.from(blob.slice(ENC_PREFIX.length), "base64");
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted blob is too short — possibly corrupt");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Wrap a credential config object for storage. When ENCRYPTION_KEY is
 * configured, returns `{ __enc: "v1", blob: "<base64>" }`. Otherwise (legacy
 * deployments without the key set), returns the object as-is so existing
 * installs keep working until the operator provisions the key. Always
 * preserves the JSON shape so the Prisma `Json` column accepts it.
 */
export function sealConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!isEncryptionConfigured()) {
    return config;
  }
  return { __enc: "v1", blob: encryptString(JSON.stringify(config)) };
}

/** Unwrap whatever was returned by sealConfig (or a legacy plaintext row). */
export function openConfig(stored: unknown): Record<string, unknown> {
  if (!stored || typeof stored !== "object") return {};
  const obj = stored as Record<string, unknown>;
  if (obj.__enc === "v1" && typeof obj.blob === "string") {
    const json = decryptString(obj.blob);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  }
  return obj;
}

/**
 * True if a stored credential blob is in the encrypted envelope format.
 * Used by the migration endpoint to skip already-encrypted rows.
 */
export function isSealedConfig(stored: unknown): boolean {
  return (
    !!stored &&
    typeof stored === "object" &&
    (stored as Record<string, unknown>).__enc === "v1"
  );
}

// --- Binary buffer envelope (used for backup .zip archives) ---------------
//
// Layout: <4-byte magic 'TT01'> <12-byte IV> <16-byte authTag> <ciphertext>
// `isEncryptedBuffer` lets restore detect an encrypted archive without
// trusting the filename alone, so a renamed file still decrypts correctly.

const BACKUP_MAGIC = Buffer.from("TT01", "ascii");

export function isEncryptedBuffer(buf: Buffer): boolean {
  return buf.length > BACKUP_MAGIC.length && buf.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC);
}

/** AES-256-GCM encrypt a binary buffer with the configured ENCRYPTION_KEY. */
export function encryptBuffer(plain: Buffer): Buffer {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([BACKUP_MAGIC, iv, authTag, ciphertext]);
}

/** Decrypt a buffer produced by encryptBuffer. Throws on tampering / wrong key. */
export function decryptBuffer(blob: Buffer): Buffer {
  if (!isEncryptedBuffer(blob)) {
    throw new Error("Buffer is not in the expected encrypted format (magic header missing)");
  }
  const key = getKey();
  const headerLen = BACKUP_MAGIC.length;
  if (blob.length < headerLen + IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted buffer is too short — possibly corrupt");
  }
  const iv = blob.subarray(headerLen, headerLen + IV_LENGTH);
  const authTag = blob.subarray(headerLen + IV_LENGTH, headerLen + IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(headerLen + IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
