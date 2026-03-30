#!/bin/bash
# Training Tracker - Automatic Report Export
# Checks for scheduled exports that are due and runs them.
# Designed to be called from cron every minute.

# Ensure node/npm are on PATH (cron uses minimal PATH)
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
# Source nvm if available (common Node.js install method)
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

APP_DIR="${1:-/opt/training-tracker}"
LOG_FILE="/var/log/training-tracker-exports.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "${LOG_FILE}"
}

log "Auto-export check started"

# Call the execute endpoint
RESPONSE=$(curl -s -X POST "http://localhost:3000/api/admin/scheduled-exports/execute" \
    -H "X-Auto-Export: true" \
    -H "Content-Type: application/json" \
    2>&1)

# Check for API errors (auth failures, server errors, etc.)
if echo "$RESPONSE" | grep -q '"error"'; then
    log "API error: ${RESPONSE}"
    exit 1
fi

RAN=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).ran)}catch{console.log('0')}" 2>/dev/null)

if [ -z "$RAN" ]; then
    log "Unexpected response: ${RESPONSE}"
    exit 1
fi

if [ "$RAN" = "0" ]; then
    # Nothing due — don't log (runs every minute, would be noisy)
    exit 0
fi

log "Ran ${RAN} export(s). Response: ${RESPONSE}"
