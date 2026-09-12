#!/bin/bash
# Training Tracker - Automatic Update
# Checks for a new version and applies it if available.
#
# Installed by install.sh as a fixed root entry in /etc/cron.d/training-tracker
# that fires every 5 minutes. The schedule itself lives in .auto-update.json,
# which the app rewrites when an admin changes it — so the app never has to
# manipulate root's crontab, and there is no privileged path from the app to
# cron at all.
#
# Because the trigger is fixed and the decision is made here, a missed window
# (host suspended, update already running) simply runs late the same day rather
# than being skipped.
#
# It is also where a pre-2.70 install finishes migrating to the unprivileged
# service model — see needs_non_root_migration below.

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"

APP_DIR="${1:-/opt/training-tracker}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

require_root "$@"

# Finish the migration to the unprivileged model, if it has not happened yet.
#
# The 2.69 updater could not install the service account or the helper units
# while installing the very release that introduces them, so a site that came
# from 2.69 is left running as root with no watcher — which also blocks the
# in-app updater. This is the first thing afterwards that runs as root on a
# schedule, so it is the natural place to finish the job. Guarded, because the
# repair chowns the whole tree and this runs every five minutes.
if needs_non_root_migration; then
    mkdir -p "${LOG_DIR}" 2>/dev/null || true
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Migrating to the unprivileged service model..." \
        >> "${LOG_DIR}/updates.log"
    ensure_non_root_runtime
    # The app is still running as root under the old unit; restart so it picks
    # up the new one and comes back as the service account.
    restart_app
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Migration complete — app now runs as ${SVC_USER}" \
        >> "${LOG_DIR}/updates.log"
fi

# Hosts without systemd have no .path unit to notice an in-app update request,
# so drain it here instead — the same validating agent, just polled rather than
# event-driven. Skipped when the unit is installed, since running both would
# race for the same request file.
if [ -f "${UPDATE_REQUEST_FILE}" ] && [ ! -f /etc/systemd/system/training-tracker-update.path ]; then
    exec bash "${SCRIPT_DIR}/update-agent.sh" "${APP_DIR}"
fi

CONFIG_FILE="${APP_DIR}/.auto-update.json"
LAST_RUN_FILE="${APP_DIR}/.auto-update-last-run"
LOG_FILE="${LOG_DIR}/updates.log"

mkdir -p "${LOG_DIR}" 2>/dev/null || true

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "${LOG_FILE}"
}

# --- Is an update due right now? ---------------------------------------------

[ -f "${CONFIG_FILE}" ] || exit 0

# One node call for the whole config; prints "enabled frequency hour minute dow".
#
# This runs as ROOT, every five minutes, on a file the unprivileged service
# account owns and can replace at will, in a directory it can create entries in.
# So the file is opened rather than read by name, and the descriptor — not the
# path — decides what happens next:
#
#   O_NOFOLLOW  a symlink at the name is refused outright, instead of having
#               root read whatever it was aimed at
#   O_NONBLOCK  a FIFO at the name returns immediately instead of waiting for a
#               writer that never comes, which would otherwise leave a hung root
#               process behind every five minutes, for ever
#   fstat       the file type and the size cap are checked against the thing
#               actually being read, so there is no second path lookup to race
#
# The existing `[ -f ]` test above is a fast path, not a guard: it is a separate
# lookup, and flipping the name between a regular file and a FIFO between the
# two was measured to hang the read in 50 of 400 attempts.
#
# The path is passed as an argument rather than spliced into the program text —
# the same rule the rest of the deploy scripts follow (see check-update.sh) -
# and every refusal falls through to the same defaults as a malformed file, so a
# tampered config means "not scheduled" rather than an error.
CONFIG=$(node -e '
  const fs = require("fs");
  const MAX = 64 * 1024;
  let out = "0 daily 3 0 0";
  let fd = -1;
  try {
    fd = fs.openSync(process.argv[1],
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (st.isFile() && st.size <= MAX) {
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const r = fs.readSync(fd, buf, off, st.size - off, off);
        if (r <= 0) break;
        off += r;
      }
      const c = JSON.parse(buf.subarray(0, off).toString("utf8"));
      const [h, m] = String(c.time || "03:00").split(":").map(Number);
      out = [
        c.enabled === true ? "1" : "0",
        c.frequency === "weekly" ? "weekly" : "daily",
        Number.isFinite(h) ? h : 3,
        Number.isFinite(m) ? m : 0,
        Number.isFinite(Number(c.dayOfWeek)) ? Number(c.dayOfWeek) : 0,
      ].join(" ");
    }
  } catch {
    /* unreadable, not a plain file, too big or not JSON: use the defaults */
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch {} }
  }
  process.stdout.write(out);
' "${CONFIG_FILE}" 2>/dev/null) || exit 0

read -r ENABLED FREQUENCY SCHED_HOUR SCHED_MIN SCHED_DOW <<< "${CONFIG}"

[ "${ENABLED}" = "1" ] || exit 0

TODAY=$(date '+%Y-%m-%d')
NOW_DOW=$(date '+%w')
NOW_MINUTES=$(( 10#$(date '+%H') * 60 + 10#$(date '+%M') ))
SCHED_MINUTES=$(( SCHED_HOUR * 60 + SCHED_MIN ))

if [ "${FREQUENCY}" = "weekly" ] && [ "${NOW_DOW}" -ne "${SCHED_DOW}" ]; then
    exit 0
fi

# Not yet time today.
[ "${NOW_MINUTES}" -ge "${SCHED_MINUTES}" ] || exit 0

# Already ran today.
if [ -f "${LAST_RUN_FILE}" ] && [ "$(cat "${LAST_RUN_FILE}" 2>/dev/null)" = "${TODAY}" ]; then
    exit 0
fi

echo "${TODAY}" > "${LAST_RUN_FILE}"

# --- Check and apply ---------------------------------------------------------

log "Auto-update check started"

CHECK_OUTPUT=$(bash "${SCRIPT_DIR}/check-update.sh" "${APP_DIR}" 2>/dev/null)
UPDATE_AVAILABLE=$(echo "$CHECK_OUTPUT" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).updateAvailable)}catch{console.log('false')}" 2>/dev/null)

if [ "$UPDATE_AVAILABLE" = "true" ]; then
    LATEST=$(echo "$CHECK_OUTPUT" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).latest)}catch{console.log('unknown')}" 2>/dev/null)
    log "Update available: ${LATEST}. Starting update..."
    if bash "${SCRIPT_DIR}/perform-update.sh" "${APP_DIR}" >> "${LOG_FILE}" 2>&1; then
        log "Auto-update to ${LATEST} completed successfully"
    else
        log "Auto-update failed. Check ${APP_DIR}/.update-status for details."
    fi
else
    log "No update available"
fi
