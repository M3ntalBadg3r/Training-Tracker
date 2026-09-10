#!/bin/bash
# Training Tracker - Daily Credential Health Check
# Probes each configured Scheduled Exports credential and updates its health
# fields in the database. Designed to be called from cron once per day so
# admins see the warning banner before any cloud refresh token expires.

# Ensure node/npm are on PATH (cron uses minimal PATH)
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
# Source nvm if available
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

APP_DIR="${1:-/opt/training-tracker}"
LOG_FILE="/var/log/training-tracker/credential-check.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "${LOG_FILE}"
}

log "Credential health check started"

# Load CRON_SECRET and sign this specific request. The signature covers the
# method, path, a timestamp and a single-use nonce — see deploy/lib/cron-sign.sh.
# shellcheck source=lib/cron-sign.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/cron-sign.sh"

if ! load_cron_secret "${APP_DIR}/.env"; then
    log "CRON_SECRET not set in .env. Aborting (required for cron authentication)."
    exit 1
fi

cron_sign_request POST "/api/admin/scheduled-exports/credentials/check"

RESPONSE=$(curl -s -X POST "http://localhost:3000/api/admin/scheduled-exports/credentials/check" \
    -H "X-Auto-Credential-Check: true" \
    -H "X-Cron-Signature: ${CRON_SIGNATURE}" \
    -H "X-Cron-Timestamp: ${CRON_TIMESTAMP}" \
    -H "X-Cron-Nonce: ${CRON_NONCE}" \
    -H "Content-Type: application/json" \
    --max-time 60 \
    2>&1)

if echo "$RESPONSE" | grep -q '"error"'; then
    log "API error: ${RESPONSE}"
    exit 1
fi

CHECKED=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).checked)}catch{console.log('?')}" 2>/dev/null)
log "Checked ${CHECKED} credential(s). Response: ${RESPONSE}"
