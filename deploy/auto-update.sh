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

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"

APP_DIR="${1:-/opt/training-tracker}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

require_root "$@"

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
CONFIG=$(node -e '
  const fs = require("fs");
  try {
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const [h, m] = String(c.time || "03:00").split(":").map(Number);
    process.stdout.write([
      c.enabled === true ? "1" : "0",
      c.frequency === "weekly" ? "weekly" : "daily",
      Number.isFinite(h) ? h : 3,
      Number.isFinite(m) ? m : 0,
      Number.isFinite(Number(c.dayOfWeek)) ? Number(c.dayOfWeek) : 0,
    ].join(" "));
  } catch { process.stdout.write("0 daily 3 0 0"); }
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
