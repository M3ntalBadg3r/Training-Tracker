#!/bin/bash
# Training Tracker - Automatic Backup
# Saves a backup to the configured directory.
# Designed to be called from cron.

APP_DIR="${1:-/opt/training-tracker}"
LOG_FILE="/var/log/training-tracker-backups.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "${LOG_FILE}"
}

log "Auto-backup started"

# Check config
CONFIG_FILE="${APP_DIR}/.auto-backup.json"
if [ ! -f "$CONFIG_FILE" ]; then
    log "No config file found at ${CONFIG_FILE}. Aborting."
    exit 1
fi

ENABLED=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG_FILE}','utf8')).enabled)" 2>/dev/null)
if [ "$ENABLED" != "true" ]; then
    log "Auto-backup is disabled. Skipping."
    exit 0
fi

# Call the save-to-disk API endpoint
RESPONSE=$(curl -s -X POST "http://localhost:3000/api/admin/backup/save" \
    -H "X-Auto-Backup: true" \
    -H "Content-Type: application/json" \
    2>&1)

SUCCESS=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).success)}catch{console.log('false')}" 2>/dev/null)

if [ "$SUCCESS" = "true" ]; then
    FILENAME=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).filename)}catch{console.log('unknown')}" 2>/dev/null)
    log "Backup completed successfully: ${FILENAME}"
else
    log "Backup failed. Response: ${RESPONSE}"
fi
