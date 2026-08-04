#!/bin/bash
# Training Tracker - privileged update helper (the root side of the boundary)
#
# Triggered by training-tracker-update.path when the unprivileged app writes
# ${APP_DIR}/.update-request. This script is the *entire* privileged surface the
# app can reach, so it treats the request file as hostile input:
#
#   - the file must be a regular file (not a symlink) owned by the service user
#   - it is size-capped, so there is nothing to exhaust
#   - its contents are matched against three literal strings and nothing else.
#     No JSON parser, no eval, no path/branch/argument is ever taken from it.
#     The only information that crosses the boundary is "which of three things
#     did you want", which is why there is nothing here to inject into.
#
# The request is deleted before any work starts, so a request that crashes the
# updater cannot re-trigger the path unit in a loop.

set -u

APP_DIR="${1:-/opt/training-tracker}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

require_root "$@"

REQ="${APP_DIR}/.update-request"
STATUS_FILE="${APP_DIR}/.update-status"
LOG_FILE="${LOG_DIR}/update-agent.log"

mkdir -p "${LOG_DIR}" 2>/dev/null || true

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "${LOG_FILE}" 2>/dev/null || true
}

reject() {
    log "REJECTED: $1"
    printf '{"step":0,"totalSteps":8,"message":"Update request rejected: %s","status":"failed"}\n' "$1" \
        > "${STATUS_FILE}" 2>/dev/null || true
    chown "${SVC_USER}:${SVC_GROUP}" "${STATUS_FILE}" 2>/dev/null || true
    exit 0
}

# --- Validate ----------------------------------------------------------------

# A symlink here would let the app point the read at any file on the system.
if [ -L "${REQ}" ]; then
    rm -f "${REQ}"
    reject "request is a symlink"
fi

if [ ! -f "${REQ}" ]; then
    # Raced with another trigger, or already handled. Nothing to do.
    exit 0
fi

REQ_OWNER="$(stat -c '%U' "${REQ}" 2>/dev/null || echo '?')"
REQ_SIZE="$(stat -c '%s' "${REQ}" 2>/dev/null || echo 0)"

if [ "${REQ_SIZE}" -gt 256 ]; then
    rm -f "${REQ}"
    reject "request too large (${REQ_SIZE} bytes)"
fi

# Only the app may ask. Anything else — including a root-owned file dropped by
# some other process — is not a request this helper knows the provenance of.
if [ "${REQ_OWNER}" != "${SVC_USER}" ]; then
    rm -f "${REQ}"
    reject "request not owned by ${SVC_USER} (owner: ${REQ_OWNER})"
fi

ACTION_RAW="$(head -c 256 "${REQ}" 2>/dev/null | tr -d '[:space:]')"

# Delete before dispatching: the path unit re-arms on the file disappearing, and
# a request that kills the updater must not be able to replay itself.
rm -f "${REQ}"

# --- Dispatch ----------------------------------------------------------------
#
# Whole-string match against a closed set. TARGET_BRANCH is set from the matched
# literal, never from the file's text.
TARGET_BRANCH=""
case "${ACTION_RAW}" in
    '{"action":"update"}')
        log "Accepted: update"
        ;;
    '{"action":"switch-channel","channel":"dev"}')
        TARGET_BRANCH="dev"
        log "Accepted: switch-channel -> dev"
        ;;
    '{"action":"switch-channel","channel":"stable"}')
        TARGET_BRANCH="master"
        log "Accepted: switch-channel -> stable"
        ;;
    *)
        reject "unrecognised request"
        ;;
esac

# --- Act ---------------------------------------------------------------------

# Idempotent; repairs an install whose service account, ownership or units have
# drifted (or were removed) before handing over to the updater.
ensure_non_root_runtime

if [ -n "${TARGET_BRANCH}" ]; then
    export TARGET_BRANCH
fi

exec bash "${SCRIPT_DIR}/perform-update.sh" "${APP_DIR}"
