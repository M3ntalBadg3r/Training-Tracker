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

# Load GITHUB_TOKEN and UPDATE_CHANNEL from .env if not already set
if [ -f "${APP_DIR}/.env" ]; then
    if [ -z "$GITHUB_TOKEN" ]; then
        GITHUB_TOKEN=$(grep -E '^GITHUB_TOKEN=' "${APP_DIR}/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    fi
    if [ -z "$UPDATE_CHANNEL" ]; then
        UPDATE_CHANNEL=$(grep -E '^UPDATE_CHANNEL=' "${APP_DIR}/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    fi
fi

# Default to stable channel
UPDATE_CHANNEL="${UPDATE_CHANNEL:-stable}"

# Query GitHub releases API
AUTH_HEADER=""
if [ -n "$GITHUB_TOKEN" ]; then
    AUTH_HEADER="-H \"Authorization: Bearer ${GITHUB_TOKEN}\""
fi

# Dev channel: fetch all releases (includes pre-releases), take the first
# Stable channel: fetch /releases/latest (excludes pre-releases)
if [ "$UPDATE_CHANNEL" = "dev" ]; then
    RESPONSE=$(eval curl -s --max-time 10 $AUTH_HEADER "https://api.github.com/repos/${REPO}/releases?per_page=1" 2>/dev/null)
    # Response is an array — extract the first element
    if echo "$RESPONSE" | grep -q '"tag_name"'; then
        LATEST=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j[0].tag_name.replace(/^v/,''))" 2>/dev/null)
        NOTES=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j[0].body||'')" 2>/dev/null)
        PUBLISHED=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j[0].published_at||'')" 2>/dev/null)
        NAME=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j[0].name||'')" 2>/dev/null)
    fi
else
    RESPONSE=$(eval curl -s --max-time 10 $AUTH_HEADER "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null)
    if echo "$RESPONSE" | grep -q '"tag_name"'; then
        LATEST=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j.tag_name.replace(/^v/,''))" 2>/dev/null)
        NOTES=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j.body||'')" 2>/dev/null)
        PUBLISHED=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j.published_at||'')" 2>/dev/null)
        NAME=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j.name||'')" 2>/dev/null)
    fi
fi

if [ -n "$LATEST" ]; then
    # Compare versions (simple numeric comparison)
    UPDATE="false"
    CURRENT_NUM=$(echo "$CURRENT" | awk -F. '{printf "%d%03d", $1, $2}')
    LATEST_NUM=$(echo "$LATEST" | awk -F. '{printf "%d%03d", $1, $2}')
    if [ "$LATEST_NUM" -gt "$CURRENT_NUM" ] 2>/dev/null; then
        UPDATE="true"
    fi

    # Output JSON using node for proper escaping
    node -e "
        console.log(JSON.stringify({
            current: '${CURRENT}',
            latest: '${LATEST}',
            channel: '${UPDATE_CHANNEL}',
            updateAvailable: ${UPDATE},
            releaseName: $(node -e "console.log(JSON.stringify('${NAME}'))" 2>/dev/null || echo '""'),
            publishedAt: '${PUBLISHED}'
        }));
    " 2>/dev/null

    # Fallback if node JSON output fails
    if [ $? -ne 0 ]; then
        echo "{\"current\":\"${CURRENT}\",\"latest\":\"${LATEST}\",\"channel\":\"${UPDATE_CHANNEL}\",\"updateAvailable\":${UPDATE},\"publishedAt\":\"${PUBLISHED}\"}"
    fi
else
    echo "{\"current\":\"${CURRENT}\",\"latest\":null,\"channel\":\"${UPDATE_CHANNEL}\",\"updateAvailable\":false,\"error\":\"Could not reach GitHub API\"}"
fi
