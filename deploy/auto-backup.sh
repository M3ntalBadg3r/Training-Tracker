#!/bin/bash
# Training Tracker - Automatic Backup
# Saves a backup to the configured directory.
#
# Installed by install.sh as a fixed entry in /etc/cron.d/training-tracker that
# fires every 5 minutes as the unprivileged service user. The schedule itself
# lives in .auto-backup.json, which the app rewrites when an admin changes it —
# so the app never has to manipulate a crontab.
#
# That indirection is not cosmetic. From v2.70 the service runs under
# ProtectSystem=strict with only APP_DIR writable, and NoNewPrivileges=yes,
# which between them make the crontab spool unwritable and neuter crontab's
# setgid bit. An app-written crontab entry cannot work under this unit at all,
# so the decision of whether a backup is due is made here instead.
#
# Because the trigger is fixed and the decision is made here, a missed window
# (host suspended, machine off overnight) runs late the same day rather than
# being skipped.
#
# It only reads .env and POSTs to localhost, so it needs no privilege.

# Ensure node/npm are on PATH (cron uses minimal PATH)
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
# Source nvm if available (common Node.js install method)
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

APP_DIR="${1:-/opt/training-tracker}"
CONFIG_FILE="${APP_DIR}/.auto-backup.json"
LAST_RUN_FILE="${APP_DIR}/.auto-backup-last-run"
LOG_FILE="/var/log/training-tracker/backups.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "${LOG_FILE}"
}

# --- Is a backup due right now? ----------------------------------------------
#
# Nothing below this block logs until a backup is actually due: this runs every
# five minutes, so an unconditional "started" line would bury the log.

[ -f "${CONFIG_FILE}" ] || exit 0

# One node call for the whole config; prints "enabled frequency hour minute dow".
#
# This runs as the service account rather than as root, so it crosses no
# privilege boundary — but it reads the same shape of file in the same place,
# and the read is hardened the same way so the two cannot drift. The file is
# opened rather than read by name, every five minutes, on a file the unprivileged service
# account owns and can replace at will, in a directory it can create entries in.
# So the file is opened rather than read by name, and the descriptor — not the
# path — decides what happens next:
#
#   O_NOFOLLOW  a symlink at the name is refused outright, instead of having
#               root read whatever it was aimed at
#   O_NONBLOCK  a FIFO at the name returns immediately instead of waiting for a
#               writer that never comes, which would otherwise leave a hung
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
  let out = "0 daily 2 0 0";
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
      const [h, m] = String(c.time || "02:00").split(":").map(Number);
      out = [
        c.enabled === true ? "1" : "0",
        c.frequency === "weekly" ? "weekly" : "daily",
        Number.isFinite(h) ? h : 2,
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

# Local time, matching the schedule the admin set in the UI. (The HMAC below
# uses a UTC unix timestamp instead — they are deliberately different clocks.)
LOCAL_TODAY=$(date '+%Y-%m-%d')
NOW_DOW=$(date '+%w')
NOW_MINUTES=$(( 10#$(date '+%H') * 60 + 10#$(date '+%M') ))
SCHED_MINUTES=$(( SCHED_HOUR * 60 + SCHED_MIN ))

if [ "${FREQUENCY}" = "weekly" ] && [ "${NOW_DOW}" -ne "${SCHED_DOW}" ]; then
    exit 0
fi

# Not yet time today. `-ge` rather than `-eq` is what makes a missed tick run
# late instead of being skipped for the day.
[ "${NOW_MINUTES}" -ge "${SCHED_MINUTES}" ] || exit 0

# Already ran today.
if [ -f "${LAST_RUN_FILE}" ] && [ "$(cat "${LAST_RUN_FILE}" 2>/dev/null)" = "${LOCAL_TODAY}" ]; then
    exit 0
fi

# Stamped before the work, not after, so a crash cannot retry every five
# minutes for the rest of the day.
echo "${LOCAL_TODAY}" > "${LAST_RUN_FILE}"

# --- Take the backup ---------------------------------------------------------

log "Auto-backup started"

# Load CRON_SECRET and sign this specific request. The signature covers the
# method, path, a timestamp and a single-use nonce — see deploy/lib/cron-sign.sh.
# shellcheck source=lib/cron-sign.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/cron-sign.sh"

if ! load_cron_secret "${APP_DIR}/.env"; then
    log "CRON_SECRET not set in .env. Aborting (required for cron authentication)."
    exit 1
fi

cron_sign_request POST "/api/admin/backup/save"

# Call the save-to-disk API endpoint
RESPONSE=$(curl -s -X POST "http://localhost:3000/api/admin/backup/save" \
    -H "X-Auto-Backup: true" \
    -H "X-Cron-Signature: ${CRON_SIGNATURE}" \
    -H "X-Cron-Timestamp: ${CRON_TIMESTAMP}" \
    -H "X-Cron-Nonce: ${CRON_NONCE}" \
    -H "Content-Type: application/json" \
    2>&1)

# Check for API errors (auth failures, server errors, etc.)
if echo "$RESPONSE" | grep -q '"error"'; then
    log "API error: ${RESPONSE}"
    exit 1
fi

SUCCESS=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).success)}catch{console.log('false')}" 2>/dev/null)

if [ "$SUCCESS" = "true" ]; then
    FILENAME=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).filename)}catch{console.log('unknown')}" 2>/dev/null)
    log "Backup completed successfully: ${FILENAME}"
else
    log "Backup failed. Response: ${RESPONSE}"
fi
