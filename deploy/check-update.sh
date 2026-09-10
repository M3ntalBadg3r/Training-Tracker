#!/bin/bash
# Training Tracker - Check for Updates
# Compares local version with latest GitHub release.
# Outputs JSON with version info.
#
# Runs as ROOT from the cron entry in lib/common.sh (via auto-update.sh), so
# every value it handles is untrusted input crossing a privilege boundary:
# package.json and .env are writable by the unprivileged service account, and
# the release name/tag come from the GitHub API. Nothing read here may reach a
# shell or a JavaScript source string — values are passed as arguments only.

APP_DIR="${1:-/opt/training-tracker}"
REPO="M3ntalBadg3r/Training-Tracker"

# Read current version from package.json
if [ ! -f "${APP_DIR}/package.json" ]; then
    echo '{"error":"package.json not found"}'
    exit 1
fi

CURRENT=$(node -e "process.stdout.write(String(require(process.argv[1]).version || ''))" "${APP_DIR}/package.json" 2>/dev/null)
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

# Query GitHub releases API.
#
# The optional auth header goes in an array, not through `eval`: GITHUB_TOKEN
# comes from a file the service account can write, so an eval'd command line
# would be root command injection.
CURL_ARGS=(-s --max-time 10)
if [ -n "$GITHUB_TOKEN" ]; then
    CURL_ARGS+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

# Always fetch the releases list and pick the highest version ourselves.
# /releases/latest relies on created_at ordering which breaks when a pre-release
# is promoted to stable after a newer pre-release has been created.
RESPONSE=$(curl "${CURL_ARGS[@]}" "https://api.github.com/repos/${REPO}/releases?per_page=20" 2>/dev/null)

if echo "$RESPONSE" | grep -q '"tag_name"'; then
    STABLE_ONLY="false"
    [ "$UPDATE_CHANNEL" != "dev" ] && STABLE_ONLY="true"

    # Single node call extracts all needed fields from the best matching release
    RELEASE_JSON=$(echo "$RESPONSE" | node -e '
        const d=require("fs").readFileSync("/dev/stdin","utf8");
        const all=JSON.parse(d);
        const stableOnly=process.argv[1]==="true";
        const candidates=stableOnly?all.filter(r=>!r.prerelease&&!r.draft):all;
        const ver=t=>t.replace(/^v/,"").replace(/-dev$/,"").split(".").reduce((a,x,i)=>a+parseInt(x||0)*(i===0?1000:1),0);
        const best=candidates.reduce((b,r)=>(!b||ver(r.tag_name)>ver(b.tag_name)?r:b),null);
        if(best) console.log(JSON.stringify({tag:best.tag_name.replace(/^v/,""),name:best.name||"",published:best.published_at||"",body:best.body||""}));
    ' "${STABLE_ONLY}" 2>/dev/null)

    if [ -n "$RELEASE_JSON" ]; then
        LATEST=$(echo "$RELEASE_JSON"   | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")).tag)' 2>/dev/null)
        NAME=$(echo "$RELEASE_JSON"     | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")).name)' 2>/dev/null)
        PUBLISHED=$(echo "$RELEASE_JSON"| node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")).published)' 2>/dev/null)
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

    # Output JSON using node for proper escaping.
    #
    # Every value is passed as an argv element and serialised by JSON.stringify.
    # They used to be spliced into the program text inside single quotes (with a
    # second, nested `node -e` for the release name), which made a release name
    # — or a package.json version, or the .env channel — containing a quote into
    # root code execution.
    if ! node -e '
        const [current,latest,channel,updateAvailable,releaseName,publishedAt]=process.argv.slice(1);
        console.log(JSON.stringify({
            current,
            latest,
            channel,
            updateAvailable: updateAvailable==="true",
            releaseName,
            publishedAt,
        }));
    ' "${CURRENT}" "${LATEST}" "${UPDATE_CHANNEL}" "${UPDATE}" "${NAME}" "${PUBLISHED}" 2>/dev/null; then
        # Fallback if node JSON output fails. Values are escaped for JSON by
        # hand here, so keep this in step with the node branch above.
        esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r\t'; }
        printf '{"current":"%s","latest":"%s","channel":"%s","updateAvailable":%s,"publishedAt":"%s"}\n' \
            "$(esc "${CURRENT}")" "$(esc "${LATEST}")" "$(esc "${UPDATE_CHANNEL}")" "${UPDATE}" "$(esc "${PUBLISHED}")"
    fi
else
    printf '{"current":"%s","latest":null,"channel":"%s","updateAvailable":false,"error":"Could not reach GitHub API"}\n' \
        "$(printf '%s' "${CURRENT}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r\t')" \
        "$(printf '%s' "${UPDATE_CHANNEL}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r\t')"
fi
