import fs from "fs";
import path from "path";

/**
 * Asking for privileged work without holding any privilege.
 *
 * The app runs as an unprivileged service user and cannot restart itself, pull
 * from git, or write outside its own directory. Rather than granting it an
 * escalation capability — a sudoers rule, a setuid helper, a polkit rule, each
 * of which is both a new package dependency and a new thing to scope wrongly —
 * it writes a request file that a root-owned systemd path unit
 * (`training-tracker-update.path`) watches. `deploy/update-agent.sh` picks the
 * request up as root, checks that the file is a regular file owned by the
 * service user and under the size cap, and matches its contents against a
 * closed set of literals before doing anything.
 *
 * That last part is why the payloads below are string constants rather than
 * `JSON.stringify` of some object: the agent compares whole strings, so these
 * are effectively an enum shared across a process boundary. Key order,
 * whitespace and spelling all have to match the `case` arms in
 * `deploy/update-agent.sh` exactly — a serializer that one day emits keys in a
 * different order would silently stop every update working. Keep the two lists
 * in step.
 */
export const UPDATE_REQUESTS = {
  update: '{"action":"update"}',
  switchToDev: '{"action":"switch-channel","channel":"dev"}',
  switchToStable: '{"action":"switch-channel","channel":"stable"}',
} as const;

export type UpdateRequest = (typeof UPDATE_REQUESTS)[keyof typeof UPDATE_REQUESTS];

export const UPDATE_REQUEST_FILENAME = ".update-request";

/**
 * Drop a request for the root-side helper. Written 0600 so only the service
 * user (and root) can read it back; the agent additionally rejects anything it
 * does not own.
 */
export function writeUpdateRequest(appDir: string, payload: UpdateRequest): void {
  fs.writeFileSync(path.join(appDir, UPDATE_REQUEST_FILENAME), payload, {
    mode: 0o600,
  });
}

/** systemd path unit that watches for the request file. */
const HELPER_UNIT = "/etc/systemd/system/training-tracker-update.path";
/** Fallback for hosts without systemd: auto-update.sh drains the request from cron. */
const HELPER_CRON = "/etc/cron.d/training-tracker";

/**
 * True when something is actually watching for the request file.
 *
 * Checking that `deploy/update-agent.sh` exists is not enough: after updating
 * *from* a pre-2.70 install, the new script is on disk but the unit that
 * triggers it was never installed — the old updater restarted the app using the
 * old unit file and knew nothing about any of this. Without this check the
 * request would be written and silently never consumed, and the update dialog
 * would just hang. Checking the consumer instead lets the caller say what to do.
 */
export function updateHelperInstalled(appDir: string): boolean {
  if (!fs.existsSync(path.join(appDir, "deploy", "update-agent.sh"))) return false;
  return fs.existsSync(HELPER_UNIT) || fs.existsSync(HELPER_CRON);
}

/** Actionable message for the case above. */
export const UPDATE_HELPER_MISSING =
  "The privileged update helper is not installed, so this update cannot be " +
  "started from the app. Run this once on the server, as root, to complete " +
  "the upgrade to the unprivileged service model:\n\n" +
  "    bash /opt/training-tracker/deploy/install.sh\n\n" +
  "(On an LXC you are usually root already. On a VM, prefix it with sudo.)";
