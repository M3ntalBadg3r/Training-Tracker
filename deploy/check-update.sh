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

# Always fetch the releases list and pick the highest version ourselves.
# /releases/latest relies on created_at ordering which breaks when a pre-release
# is promoted to stable after a newer pre-release has been created.
RESPONSE=$(eval curl -s --max-time 10 $AUTH_HEADER "https://api.github.com/repos/${REPO}/releases?per_page=20" 2>/dev/null)

if echo "$RESPONSE" | grep -q '"tag_name"'; then
    STABLE_ONLY="false"
    [ "$UPDATE_CHANNEL" != "dev" ] && STABLE_ONLY="true"

    # Single node call extracts all needed fields from the best matching release
    RELEASE_JSON=$(echo "$RESPONSE" | node -e "
        const d=require('fs').readFileSync('/dev/stdin','utf8');
        const all=JSON.parse(d);
        const stableOnly=${STABLE_ONLY};
        const candidates=stableOnly?all.filter(r=>!r.prerelease&&!r.draft):all;
        const ver=t=>t.replace(/^v/,'').replace(/-dev$/,'').split('.').reduce((a,x,i)=>a+parseInt(x||0)*(i===0?1000:1),0);
        const best=candidates.reduce((b,r)=>(!b||ver(r.tag_name)>ver(b.tag_name)?r:b),null);
        if(best) console.log(JSON.stringify({tag:best.tag_name.replace(/^v/,''),name:best.name||'',published:best.published_at||'',body:best.body||''}));
    " 2>/dev/null)

    if [ -n "$RELEASE_JSON" ]; then
        LATEST=$(echo "$RELEASE_JSON"   | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).tag)" 2>/dev/null)
        NAME=$(echo "$RELEASE_JSON"     | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).name)" 2>/dev/null)
        PUBLISHED=$(echo "$RELEASE_JSON"| node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).published)" 2>/dev/null)
        NOTES=$(echo "$RELEASE_JSON"    | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).body)" 2>/dev/null)
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
