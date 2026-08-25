/**
 * Auth constants shared between server routes and client components.
 *
 * Deliberately its own module: `lib/auth.ts` pulls in bcryptjs, otpauth and
 * (via lib/user-status) Prisma, none of which can be bundled into a client
 * component — so the pieces the browser also needs live here instead.
 */

/**
 * Marks a 401 as "this session is over, sign out" rather than "you aren't
 * signed in". Set by the auth guards when the signed-in account has been
 * disabled; `AuthProvider` watches for it and performs a clean logout, which is
 * what makes a suspension take effect on the user's very next request.
 */
export const SESSION_TERMINATED_HEADER = "X-Session-Terminated";

/** `AuthError.code` / response `code` for a session on a suspended account. */
export const ACCOUNT_DISABLED_CODE = "ACCOUNT_DISABLED";
