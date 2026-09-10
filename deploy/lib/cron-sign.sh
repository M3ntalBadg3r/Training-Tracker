#!/bin/bash
# Shared HMAC signing for the cron scripts (auto-backup, auto-export,
# auto-credential-check).
#
# Needs no privilege: it only reads CRON_SECRET out of .env and does arithmetic,
# so it is sourced by scripts running as the service user.
#
# ---------------------------------------------------------------------------
# KEEP IN LOCKSTEP WITH src/lib/cron-auth.ts
#
# `cron_signing_string` below and `cronSigningString` there must produce a byte
# identical string. This is the same standing rule as UPDATE_REQUESTS vs
# update-agent.sh: if the two drift, every scheduled backup, export and
# credential check silently starts returning 401, and the failure looks like a
# credentials problem rather than a format mismatch.
#
# The signature covers the method, the exact path, a timestamp and a nonce, so
# it authorises one call to one endpoint inside a short window — and the server
# records the nonce, so it works only once. The previous scheme signed just the
# UTC date, which made one captured value replayable against all three endpoints
# for 24 hours.
# ---------------------------------------------------------------------------

CRON_SIGNATURE_VERSION="v1"

# Read CRON_SECRET from .env. Sets the global CRON_SECRET; returns non-zero when
# it is missing so the caller can abort with its own log message.
load_cron_secret() {
    local env_file="$1"
    CRON_SECRET=""
    if [ -f "${env_file}" ]; then
        CRON_SECRET=$(grep -oP '^CRON_SECRET=["'"'"']?\K[^"'"'"']*' "${env_file}" 2>/dev/null || true)
    fi
    [ -n "${CRON_SECRET}" ]
}

# Build the canonical string that is signed. Mirrored by cronSigningString() in
# src/lib/cron-auth.ts — change both together.
#   cron_signing_string <METHOD> <path> <timestamp> <nonce>
cron_signing_string() {
    printf '%s:%s:%s:%s:%s' "${CRON_SIGNATURE_VERSION}" "$1" "$2" "$3" "$4"
}

# Emit the three cron headers as curl arguments for the given method and path.
# Sets the globals CRON_TIMESTAMP, CRON_NONCE and CRON_SIGNATURE.
#
#   cron_sign_request POST /api/admin/backup/save
#
# The nonce is 16 random bytes as lowercase hex, which is the shape
# src/lib/cron-auth.ts validates before the value is used as a store key.
cron_sign_request() {
    local method="$1" path="$2"
    CRON_TIMESTAMP=$(date -u '+%s')
    CRON_NONCE=$(openssl rand -hex 16)
    CRON_SIGNATURE=$(
        cron_signing_string "${method}" "${path}" "${CRON_TIMESTAMP}" "${CRON_NONCE}" \
            | openssl dgst -sha256 -hmac "${CRON_SECRET}" \
            | awk '{print $NF}'
    )
}
