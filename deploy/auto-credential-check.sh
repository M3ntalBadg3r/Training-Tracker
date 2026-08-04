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

# Load CRON_SECRET from .env for HMAC signature
ENV_FILE="${APP_DIR}/.env"
CRON_SECRET=""
if [ -f "$ENV_FILE" ]; then
    CRON_SECRET=$(grep -oP '^CRON_SECRET=["'"'"']?\K[^"'"'"']*' "$ENV_FILE" 2>/dev/null || true)
fi

if [ -z "$CRON_SECRET" ]; then
    log "CRON_SECRET not set in .env. Aborting (required for cron authentication)."
    exit 1
fi

# Compute HMAC-SHA256 signature of today's date (UTC)
TODAY=$(date -u '+%Y-%m-%d')
CRON_SIGNATURE=$(echo -n "$TODAY" | openssl dgst -sha256 -hmac "$CRON_SECRET" | awk '{print $NF}')

RESPONSE=$(curl -s -X POST "http://localhost:3000/api/admin/scheduled-exports/credentials/check" \
    -H "X-Cron-Signature: ${CRON_SIGNATURE}" \
    -H "Content-Type: application/json" \
    --max-time 60 \
    2>&1)

if echo "$RESPONSE" | grep -q '"error"'; then
    log "API error: ${RESPONSE}"
    exit 1
fi

CHECKED=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).checked)}catch{console.log('?')}" 2>/dev/null)
log "Checked ${CHECKED} credential(s). Response: ${RESPONSE}"
