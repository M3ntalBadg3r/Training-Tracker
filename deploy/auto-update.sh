#!/bin/bash
# Training Tracker - Automatic Update
# Checks for a new version and applies it if available.
# Designed to be called from cron.
# Needs root — re-execs under sudo when run manually by a non-root user.
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        exec sudo -E bash "$0" "$@"
    fi
    echo "ERROR: This script must be run as root and sudo is not available." >&2
    exit 1
fi

APP_DIR="${1:-/opt/training-tracker}"
LOG_FILE="/var/log/training-tracker-updates.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "${LOG_FILE}"
}

log "Auto-update check started"

# Run version check
CHECK_OUTPUT=$(bash "${APP_DIR}/deploy/check-update.sh" "${APP_DIR}" 2>/dev/null)
UPDATE_AVAILABLE=$(echo "$CHECK_OUTPUT" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).updateAvailable)}catch{console.log('false')}" 2>/dev/null)

if [ "$UPDATE_AVAILABLE" = "true" ]; then
    LATEST=$(echo "$CHECK_OUTPUT" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).latest)}catch{console.log('unknown')}" 2>/dev/null)
    log "Update available: ${LATEST}. Starting update..."
    bash "${APP_DIR}/deploy/perform-update.sh" "${APP_DIR}" >> "${LOG_FILE}" 2>&1
    if [ $? -eq 0 ]; then
        log "Auto-update to ${LATEST} completed successfully"
    else
        log "Auto-update failed. Check ${APP_DIR}/.update-status for details."
    fi
else
    log "No update available"
fi
