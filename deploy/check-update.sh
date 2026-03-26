#!/bin/bash
# Training Tracker - Check for Updates
# Compares local version with latest GitHub release.
# Outputs JSON with version info.

APP_DIR="${1:-/opt/training-tracker}"
REPO="M3ntalBadg3r/Training-Tracker"

# Read current version from package.json
if [ ! -f "${APP_DIR}/package.json" ]; then
    echo '{"error":"package.json not found"}'
    exit 1
fi

CURRENT=$(node -e "console.log(require('${APP_DIR}/package.json').version)" 2>/dev/null)
if [ -z "$CURRENT" ]; then
    echo '{"error":"Could not read current version"}'
    exit 1
fi

# Load GITHUB_TOKEN from .env if not already set
if [ -z "$GITHUB_TOKEN" ] && [ -f "${APP_DIR}/.env" ]; then
    GITHUB_TOKEN=$(grep -E '^GITHUB_TOKEN=' "${APP_DIR}/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
fi

# Query GitHub releases API
AUTH_HEADER=""
if [ -n "$GITHUB_TOKEN" ]; then
    AUTH_HEADER="-H \"Authorization: Bearer ${GITHUB_TOKEN}\""
fi
RESPONSE=$(eval curl -s --max-time 10 $AUTH_HEADER "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null)

if echo "$RESPONSE" | grep -q '"tag_name"'; then
    LATEST=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j.tag_name.replace(/^v/,''))" 2>/dev/null)
    NOTES=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j.body||'')" 2>/dev/null)
    PUBLISHED=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j.published_at||'')" 2>/dev/null)
    NAME=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j.name||'')" 2>/dev/null)

    # Compare versions (simple numeric comparison)
    UPDATE="false"
    if [ -n "$LATEST" ]; then
        CURRENT_NUM=$(echo "$CURRENT" | awk -F. '{printf "%d%03d", $1, $2}')
        LATEST_NUM=$(echo "$LATEST" | awk -F. '{printf "%d%03d", $1, $2}')
        if [ "$LATEST_NUM" -gt "$CURRENT_NUM" ] 2>/dev/null; then
            UPDATE="true"
        fi
    fi

    # Output JSON using node for proper escaping
    node -e "
        console.log(JSON.stringify({
            current: '${CURRENT}',
            latest: '${LATEST}',
            updateAvailable: ${UPDATE},
            releaseName: $(node -e "console.log(JSON.stringify('${NAME}'))" 2>/dev/null || echo '""'),
            publishedAt: '${PUBLISHED}'
        }));
    " 2>/dev/null

    # Fallback if node JSON output fails
    if [ $? -ne 0 ]; then
        echo "{\"current\":\"${CURRENT}\",\"latest\":\"${LATEST}\",\"updateAvailable\":${UPDATE},\"publishedAt\":\"${PUBLISHED}\"}"
    fi
else
    echo "{\"current\":\"${CURRENT}\",\"latest\":null,\"updateAvailable\":false,\"error\":\"Could not reach GitHub API\"}"
fi
