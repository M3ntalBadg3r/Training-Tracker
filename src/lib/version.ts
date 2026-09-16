/**
 * The app's view of the version comparator.
 *
 * This is a re-export, not an implementation. The single implementation lives in
 * `deploy/lib/version.mjs` — see that file for why it is on the deploy side
 * (short version: `deploy/check-update.sh` runs as root and must not import a
 * module the unprivileged app can rewrite) and for the migration constraint that
 * governs which version numbers installed boxes can actually see.
 *
 * Importing across that boundary is a **build-time** dependency only: Next
 * inlines the module into `.next`, and the running app never reads `deploy/`.
 * The service user can read `deploy/` (`ensure_ownership` applies `go-w`, which
 * removes write and leaves read), so the production build resolves it.
 *
 * Keeping it to one implementation is what makes a parity check unnecessary
 * here, unlike `cron-auth.ts` vs `cron-sign.sh` — those duplicate only because
 * bash cannot call TypeScript.
 */

export {
  parseVersion,
  compareVersions,
  isNewerVersion,
  versionFromTag,
  isPrereleaseVersion,
} from "../../deploy/lib/version.mjs";
