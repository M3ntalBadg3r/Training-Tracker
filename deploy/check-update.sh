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

# Version ordering comes from the shared module rather than a copy inlined here.
# This script used to carry TWO comparators that disagreed with each other and
# with the app's: an inline `node -e` reduce that SUMMED the patch component (so
# "2.96.3" and "2.99" both scored 2099) and an `awk` printf that dropped it.
#
# The path is derived from this script's own location, so root imports a
# root-owned file. It must never be taken from APP_DIR's app-writable side: the
# service account could then choose the code root runs. That is the same rule as
# "root parses .env, never sources it".
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION_MODULE="${SCRIPT_DIR}/lib/version.mjs"

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

# Query GitHub. The optional auth header goes in an array, not through `eval`:
# GITHUB_TOKEN comes from a file the service account can write, so an eval'd
# command line would be root command injection.
CURL_ARGS=(-s --max-time 10)
if [ -n "$GITHUB_TOKEN" ]; then
    CURL_ARGS+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

# ---------------------------------------------------------------------------
# Dev ("edge") channel: compare commits, not versions.
#
# The dev channel publishes no GitHub releases. Every merge into dev used to cut
# a `v<version>-dev` pre-release purely so this check had a version to compare,
# which is how the releases page — which customers read — came to carry dozens of
# entries a week. The installer pulls the `dev` branch directly, so the head of
# that branch is the same signal without the noise.
#
# This uses `git ls-remote` rather than the GitHub API deliberately. auto-update.sh
# runs this every 5 minutes: that is 12 API calls an hour against an
# unauthenticated budget of 60 an hour PER IP, shared by every install behind the
# same egress address, plus every load of /admin/updates. `ls-remote` costs
# nothing, needs no token, and is exact. It is also read-only — it writes nothing
# into .git, so it cannot race the updater or corrupt state.
#
# Safe to run git as root here: APP_DIR/.git is root-owned (see the ownership
# invariant in CLAUDE.md), which is also why perform-update.sh can `git pull`.
#
# On ANY failure this falls through to the release check below rather than
# reporting "up to date". A checker that goes quiet strands the box: nothing but
# an update can replace this script, so a false "no update" is permanent.
# ---------------------------------------------------------------------------
if [ "$UPDATE_CHANNEL" = "dev" ]; then
    LOCAL_COMMIT=$(git -C "${APP_DIR}" rev-parse HEAD 2>/dev/null)
    REMOTE_COMMIT=$(git -C "${APP_DIR}" ls-remote origin refs/heads/dev 2>/dev/null | cut -f1)

    if printf '%s' "${LOCAL_COMMIT}" | grep -Eq '^[0-9a-f]{40}$' &&
       printf '%s' "${REMOTE_COMMIT}" | grep -Eq '^[0-9a-f]{40}$'; then
        DEV_UPDATE="false"
        [ "${LOCAL_COMMIT}" != "${REMOTE_COMMIT}" ] && DEV_UPDATE="true"

        # Values are passed as argv elements and serialised by JSON.stringify —
        # never spliced into the program text. See the header.
        if node -e '
            const [current,channel,updateAvailable,local,remote]=process.argv.slice(1);
            console.log(JSON.stringify({
                current,
                latest: updateAvailable==="true" ? remote.slice(0,7) : current,
                channel,
                updateAvailable: updateAvailable==="true",
                localCommit: local,
                remoteCommit: remote,
            }));
        ' "${CURRENT}" "${UPDATE_CHANNEL}" "${DEV_UPDATE}" "${LOCAL_COMMIT}" "${REMOTE_COMMIT}" 2>/dev/null; then
            exit 0
        fi
    fi
    # Fell through: git could not answer. The release check below still runs.
fi

# Always fetch the releases list and pick the highest version ourselves.
# /releases/latest relies on created_at ordering which breaks when a pre-release
# is promoted to stable after a newer pre-release has been created.
RESPONSE=$(curl "${CURL_ARGS[@]}" "https://api.github.com/repos/${REPO}/releases?per_page=100" 2>/dev/null)

if echo "$RESPONSE" | grep -q '"tag_name"'; then
    # The dev channel only reaches here when the git comparison above failed,
    # in which case any release — pre-release included — is a better signal
    # than silence.
    STABLE_ONLY="false"
    [ "$UPDATE_CHANNEL" != "dev" ] && STABLE_ONLY="true"

    # Single node call extracts all needed fields from the best matching release
    RELEASE_JSON=$(echo "$RESPONSE" | node --input-type=module -e '
        import { readFileSync } from "node:fs";
        const [modulePath, stableOnlyArg] = process.argv.slice(1);
        const { compareVersions, versionFromTag } = await import(modulePath);
        const all = JSON.parse(readFileSync("/dev/stdin", "utf8"));
        const stableOnly = stableOnlyArg === "true";
        const candidates = stableOnly ? all.filter(r => !r.prerelease && !r.draft) : all;
        const best = candidates.reduce(
            (b, r) => (!b || compareVersions(versionFromTag(r.tag_name), versionFromTag(b.tag_name)) > 0 ? r : b),
            null
        );
        if (best) console.log(JSON.stringify({
            tag: versionFromTag(best.tag_name),
            name: best.name || "",
            published: best.published_at || "",
            body: best.body || "",
        }));
    ' "${VERSION_MODULE}" "${STABLE_ONLY}" 2>/dev/null)

    if [ -n "$RELEASE_JSON" ]; then
        LATEST=$(echo "$RELEASE_JSON"   | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")).tag)' 2>/dev/null)
        NAME=$(echo "$RELEASE_JSON"     | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")).name)' 2>/dev/null)
        PUBLISHED=$(echo "$RELEASE_JSON"| node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")).published)' 2>/dev/null)
    fi
fi

if [ -n "$LATEST" ]; then
    # Semver comparison, from the same module the app uses. This was an
    # `awk -F. '{printf "%d%03d", $1, $2}'` pair, which silently dropped the
    # patch component — so 3.30.1 and 3.30.0 compared equal and a patch release
    # would never have been offered to anyone.
    #
    # Values are passed as argv elements, never spliced into the program text:
    # CURRENT comes from a service-user-owned package.json and LATEST from the
    # GitHub API, and this runs as root.
    UPDATE=$(node --input-type=module -e '
        const [modulePath, latest, current] = process.argv.slice(1);
        const { isNewerVersion } = await import(modulePath);
        process.stdout.write(isNewerVersion(latest, current) ? "true" : "false");
    ' "${VERSION_MODULE}" "${LATEST}" "${CURRENT}" 2>/dev/null)
    [ "$UPDATE" = "true" ] || UPDATE="false"

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
