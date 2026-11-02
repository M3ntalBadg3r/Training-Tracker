/**
 * The app's view of the Node.js security floor.
 *
 * A re-export, like `version.ts`: the single table lives in
 * `deploy/lib/node-runtime.mjs` because root reads it during an update to
 * decide whether to upgrade the host's `nodejs` package, and root must not
 * import a module the app can rewrite. The app reads the same table to warn —
 * on Admin › Updates and at boot — when the Node it is running on is below the
 * floor, which is what tells an operator the automatic upgrade did not happen
 * (no apt, a Node not installed from a package, automatic updates switched off).
 *
 * Build-time import only; the running app never reads `deploy/`.
 */

export {
  NODE_SECURITY_FLOORS,
  assessNodeVersion,
} from "../../deploy/lib/node-runtime.mjs";
