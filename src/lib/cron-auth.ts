import crypto from "crypto";

/**
 * Verify that a cron request is authentic using HMAC-SHA256 signatures.
 * The cron shell scripts sign the current UTC date with CRON_SECRET,
 * and this function verifies that signature.
 *
 * If CRON_SECRET is not configured, cron auth is denied (secure default).
 */
export function verifyCronSignature(signature: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (!signature) return false;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const expected = crypto
    .createHmac("sha256", secret)
    .update(today)
    .digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}
