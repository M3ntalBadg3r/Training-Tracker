#!/bin/bash
# Training Tracker - Perform Update with Progress Tracking & Rollback
# Creates a pre-update backup, performs the update, and automatically
# rolls back on failure. Writes progress to .update-status and a
# detailed log to .update-log.
#
# Runs as root — normally launched by deploy/update-agent.sh via the
# training-tracker-update.path unit, or manually by an operator. Root is needed
# for exactly two things: the git operations (deploy/ and .git are root-owned so
# the unprivileged app cannot rewrite the code root executes) and the service
# restart. Everything else — npm install, prisma, the production build, pg_dump
# — is dropped to the service user via run_as_service_user, so a hostile
# dependency's postinstall script never sees root.

APP_DIR="${1:-/opt/training-tracker}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

require_root "$@"

# Idempotent; ensures the service account, ownership and helper units are in
# place before the update runs. (This cannot rescue the 2.69 -> 2.70 hop itself,
# since that update is driven by 2.69's copy of this script — see the release
# notes for the one-time `deploy/install.sh` run.)
ensure_non_root_runtime

STATUS_FILE="${APP_DIR}/.update-status"
LOG_FILE="${APP_DIR}/.update-log"
BACKUP_DIR="${APP_DIR}/.update-backup"
TOTAL_STEPS=8

# Ensure system binaries are on PATH
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"

# Source .env so DATABASE_URL (and other vars) are available to all child processes
if [ -f "${APP_DIR}/.env" ]; then
    set -a
    source "${APP_DIR}/.env"
    set +a
fi

# Make Node trust the system CA bundle (covers SSL-inspecting proxies). New
# installs persist NODE_EXTRA_CA_CERTS in .env; this self-heals older installs
# that predate that so the Prisma engine download during updates still works.
if [ -z "${NODE_EXTRA_CA_CERTS}" ] && [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
fi

# Unset NODE_ENV so npm install includes devDependencies (prisma, dotenv, etc.)
unset NODE_ENV

BEFORE_COMMIT=""
MIGRATIONS_RAN=false

# --- Logging ---

# Root writes both of these and the app reads them, so they are root-owned and
# group-writable — see ensure_state_file in lib/common.sh for why handing them
# to the service user (as this used to) silently breaks every write below.
ensure_state_file "${STATUS_FILE}" "${LOG_FILE}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "${LOG_FILE}"
}

write_status() {
    local step="$1"
    local message="$2"
    local status="$3"
    local extra="$4"
    echo "{\"step\":${step},\"totalSteps\":${TOTAL_STEPS},\"message\":\"${message}\",\"status\":\"${status}\"${extra}}" > "${STATUS_FILE}"
}

write_error() {
    local step="$1"
    local message="$2"
    local error="$3"
    error=$(echo "$error" | sed 's/"/\\"/g' | tr '\n' ' ' | head -c 2000)
    write_status "$step" "$message" "error" ",\"error\":\"${error}\",\"rolledBack\":true"
    log "ERROR at step ${step}: ${message}"
    log "Details: ${error}"
}

# --- Rollback ---

rollback() {
    local failed_step="$1"
    local error_msg="$2"
    # Optional operator-facing detail. write_status writes "message" into the
    # JSON unescaped, so error_msg stays a short fixed headline; the detail goes
    # through write_error's escaping into the "error" field, which is the one the
    # admin Updates page renders as the explanation. Step 5 passes a classified
    # reason for a failed build here.
    local detail="${3:-Update failed and was rolled back automatically. Check the update log for details.}"

    log "=== ROLLBACK STARTED ==="
    log "Failed at step ${failed_step}: ${error_msg}"

    # Restore git state
    if [ -n "$BEFORE_COMMIT" ]; then
        log "Restoring git to commit ${BEFORE_COMMIT}..."
        git checkout "${BEFORE_COMMIT}" -- . 2>/dev/null
        git checkout "${BRANCH}" 2>/dev/null
        git reset --hard "${BEFORE_COMMIT}" 2>/dev/null
        log "Git restored to ${BEFORE_COMMIT}"
    fi

    # Restore database if migrations ran. The redirection is performed by this
    # (root) shell, so BACKUP_DIR stays root-owned while psql itself does not
    # need to be root — it authenticates with DATABASE_URL, not peer auth.
    if [ "$MIGRATIONS_RAN" = true ] && [ -f "${BACKUP_DIR}/db-pre-update.sql" ]; then
        log "Restoring database from backup..."
        if command -v psql &> /dev/null && [ -n "${DATABASE_URL}" ]; then
            run_as_service_user psql "${DATABASE_URL}" < "${BACKUP_DIR}/db-pre-update.sql" 2>> "${LOG_FILE}" && \
                log "Database restored successfully" || \
                log "WARNING: Database restore failed — manual intervention may be required"
        else
            log "WARNING: psql not found or DATABASE_URL not set — cannot restore database automatically"
        fi
    fi

    # Restore .next build. .next belongs to the service user, and root cannot
    # write inside a directory it does not own on a container without an
    # effective CAP_DAC_OVERRIDE — so the removal and the copy both drop
    # privilege. This is the rollback path; a latent failure here would only
    # surface during an already-failing update.
    if [ -d "${BACKUP_DIR}/.next" ]; then
        log "Restoring previous build..."
        run_as_service_user rm -rf "${APP_DIR}/.next"
        run_as_service_user cp -r "${BACKUP_DIR}/.next" "${APP_DIR}/.next"
        log "Build restored"
    fi

    # The restored tree was written by root; hand it back before restarting.
    ensure_ownership

    # Regenerate Prisma client for restored schema
    log "Regenerating Prisma client..."
    cd "${APP_DIR}" && run_as_service_user npx prisma generate 2>> "${LOG_FILE}" || true

    # Restart service with old build
    log "Restarting service with previous version..."
    restart_app

    log "=== ROLLBACK COMPLETE ==="
    write_error "$failed_step" "$error_msg" "$detail"
}

# --- Main ---

cd "${APP_DIR}" || {
    write_error 0 "Application directory not found" "Directory ${APP_DIR} does not exist"
    exit 1
}

# Clear previous log
echo "=== Update started at $(date '+%Y-%m-%d %H:%M:%S') ===" > "${LOG_FILE}"

# Step 1: Create pre-update backup
write_status 1 "Creating pre-update backup..." "in_progress"
log "Step 1: Creating pre-update backup"

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || {
    write_error 1 "Not a git repository" "The application directory is not a git repository. Cannot update."
    exit 1
}

# Recover from detached HEAD (can occur after a previous failed rollback)
if [ "$BRANCH" = "HEAD" ]; then
    _CHANNEL=$(grep -E "^UPDATE_CHANNEL=" "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'" | tr -d ' ')
    if [ "$_CHANNEL" = "dev" ]; then
        BRANCH="dev"
    else
        BRANCH="master"
    fi
    log "Detected detached HEAD — restoring to branch ${BRANCH}"
    git checkout "${BRANCH}" 2>/dev/null || {
        write_error 1 "Failed to restore branch" "Git is in detached HEAD state and could not checkout branch ${BRANCH}. Run: cd ${APP_DIR} && git checkout ${BRANCH}"
        exit 1
    }
fi

BEFORE_COMMIT=$(git rev-parse HEAD 2>/dev/null)
OLD_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
log "Current version: ${OLD_VERSION}"
log "Current commit: ${BEFORE_COMMIT}"
log "Branch: ${BRANCH}"

# Create backup directory
rm -rf "${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"

# Backup .next build
if [ -d "${APP_DIR}/.next" ]; then
    log "Backing up .next directory..."
    cp -r "${APP_DIR}/.next" "${BACKUP_DIR}/.next"
    log ".next backup complete"
else
    log "No .next directory to back up"
fi

# Backup database
log "Backing up database..."
if command -v pg_dump &> /dev/null; then
    if [ -n "${DATABASE_URL}" ]; then
        run_as_service_user pg_dump "${DATABASE_URL}" > "${BACKUP_DIR}/db-pre-update.sql" 2>> "${LOG_FILE}" && \
            log "Database backup complete ($(du -sh "${BACKUP_DIR}/db-pre-update.sql" 2>/dev/null | cut -f1))" || \
            log "WARNING: Database backup failed — continuing without DB backup"
    else
        log "WARNING: DATABASE_URL not set — continuing without DB backup"
    fi
else
    log "WARNING: pg_dump not found — continuing without DB backup"
fi

# Write manifest
echo "{\"commit\":\"${BEFORE_COMMIT}\",\"version\":\"${OLD_VERSION}\",\"timestamp\":\"$(date -Iseconds)\",\"branch\":\"${BRANCH}\"}" > "${BACKUP_DIR}/manifest.json"
log "Backup manifest written"

# Step 2: Pull latest changes
write_status 2 "Pulling latest changes..." "in_progress"
log "Step 2: Pulling latest changes"

if ! git diff --quiet 2>/dev/null; then
    log "Stashing local changes..."
    git stash --quiet 2>/dev/null
fi

# Switch branch if TARGET_BRANCH is set (used by channel switching)
if [ -n "$TARGET_BRANCH" ] && [ "$TARGET_BRANCH" != "$BRANCH" ]; then
    log "Switching branch from ${BRANCH} to ${TARGET_BRANCH}..."
    git fetch origin "${TARGET_BRANCH}" 2>/dev/null
    git checkout "${TARGET_BRANCH}" 2>/dev/null || {
        log "Branch checkout failed"
        rollback 2 "Failed to switch to branch ${TARGET_BRANCH}"
        exit 1
    }
    BRANCH="${TARGET_BRANCH}"
    log "Switched to branch ${BRANCH}"
fi

# Ensure the git remote URL uses the correct auth format for private repos.
# If GITHUB_TOKEN is set, the URL must be https://x-access-token:TOKEN@github.com/...
# A common misconfiguration is https://TOKEN@github.com/... (token as username only),
# which causes git to prompt for a password and fail in non-interactive contexts.
if [ -n "${GITHUB_TOKEN}" ]; then
    DESIRED_REMOTE="https://x-access-token:${GITHUB_TOKEN}@github.com/M3ntalBadg3r/Training-Tracker.git"
    CURRENT_REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
    if [ "${CURRENT_REMOTE}" != "${DESIRED_REMOTE}" ]; then
        log "Updating git remote URL to use x-access-token auth format..."
        git remote set-url origin "${DESIRED_REMOTE}"
    fi
fi

PULL_OUTPUT=$(git pull origin "${BRANCH}" 2>&1) || {
    log "Git pull failed: ${PULL_OUTPUT}"
    rollback 2 "Failed to pull latest changes"
    exit 1
}
log "Git pull successful"

# git ran as root, so anything it just wrote is root-owned. Hand the new tree to
# the service user (and re-lock deploy/ + .git) before the build steps, which
# run unprivileged from here on.
ensure_ownership

# Re-apply the deploy layer from the version just pulled, in a *fresh* bash so it
# reads the new lib/common.sh rather than the copy sourced before the pull. This
# is how changes to the unit files or the ownership model actually ship: without
# it they would not take effect until the update after next.
APP_DIR="${APP_DIR}" bash -c '. "$1"; ensure_non_root_runtime' _ "${SCRIPT_DIR}/lib/common.sh" >> "${LOG_FILE}" 2>&1 || \
    log "WARNING: post-pull deploy refresh failed — unit files may be stale"

NEW_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
log "New version: ${NEW_VERSION}"

# Step 3: Install dependencies
write_status 3 "Installing dependencies..." "in_progress"
log "Step 3: Installing dependencies"
INSTALL_OUTPUT=$(run_as_service_user npm install 2>&1) || {
    log "npm install failed: ${INSTALL_OUTPUT}"
    rollback 3 "Failed to install dependencies"
    exit 1
}
log "Dependencies installed"

# Self-heal npm's optional-dependency bug (npm/cli#4828) on cross-platform
# lockfiles. ensure_native_deps probes both native engines the build needs — see
# lib/common.sh for why probing only lightningcss was not enough.
HEAL_OUTPUT=$(ensure_native_deps 2>&1) || {
    log "Native engine repair failed: ${HEAL_OUTPUT}"
    rollback 3 "The platform-native build engine could not be installed"
    exit 1
}
[ -n "${HEAL_OUTPUT}" ] && log "${HEAL_OUTPUT}" || true

# Step 4: Run database migrations
write_status 4 "Running database migrations..." "in_progress"
log "Step 4: Running database migrations"
MIGRATE_OUTPUT=$(run_as_service_user npx prisma migrate deploy 2>&1) || {
    log "Migration failed: ${MIGRATE_OUTPUT}"
    rollback 4 "Database migration failed"
    exit 1
}
MIGRATIONS_RAN=true
log "Migrations applied"

GENERATE_OUTPUT=$(run_as_service_user npx prisma generate 2>&1) || {
    log "Prisma generate failed: ${GENERATE_OUTPUT}"
    rollback 4 "Prisma client generation failed"
    exit 1
}
log "Prisma client generated"

# Step 5: Build application
#
# The build is the step most likely to fail on a small host, and until 2.76 it
# failed opaquely: the app is still running at this point (the restart is step 6)
# alongside Postgres, so on a memory-constrained system the kernel kills the
# Turbopack child process and the update rolls back reporting only "Build
# failed". Three things guard against that now — a pre-flight that stops the app
# when memory is tight, one retry that stops it if the first build died anyway,
# and a classified error message when both fail.
write_status 5 "Building application..." "in_progress"
log "Step 5: Building application"

BUILD_START=$(date +%s)
AVAILABLE_MB=$(available_memory_mb)
MIN_MB=$(build_min_mb)
APP_STOPPED=false
log "Memory available for the build: ${AVAILABLE_MB} MB (want at least ${MIN_MB} MB)"

# Pre-flight: hand the running app's memory back before building. Above the
# threshold nothing changes, so a healthy host sees no extra downtime.
if [ "${AVAILABLE_MB}" -lt "${MIN_MB}" ]; then
    log "Low memory — stopping the app for the duration of the build"
    write_status 5 "Building application (low memory — app paused)..." "in_progress"
    stop_app
    APP_STOPPED=true
fi

BUILD_OUTPUT=$(run_as_service_user npm run build 2>&1)
BUILD_RC=$?

# One retry, and only a targeted one. If the app was still running, stopping it
# frees the memory the build was short of; clearing .next/cache drops a stale
# Turbopack cache carried across a Next.js version bump. Either way this turns
# the common failure into a completed update instead of a rollback.
if [ "${BUILD_RC}" -ne 0 ]; then
    log "Build failed (rc=${BUILD_RC}); retrying once with the app stopped and the build cache cleared"
    capture_panic_logs "${BUILD_START}" "${LOG_FILE}"
    log "First attempt output: ${BUILD_OUTPUT}"

    if [ "${APP_STOPPED}" = false ]; then
        write_status 5 "Retrying build (app paused)..." "in_progress"
        stop_app
        APP_STOPPED=true
    fi
    run_as_service_user rm -rf "${APP_DIR}/.next/cache"

    BUILD_START=$(date +%s)
    AVAILABLE_MB=$(available_memory_mb)
    log "Memory available for the retry: ${AVAILABLE_MB} MB"
    BUILD_OUTPUT=$(run_as_service_user npm run build 2>&1)
    BUILD_RC=$?
fi

if [ "${BUILD_RC}" -ne 0 ]; then
    log "Build failed on retry: ${BUILD_OUTPUT}"
    capture_panic_logs "${BUILD_START}" "${LOG_FILE}"
    # Both realistic causes look identical in the build output; classify_build_failure
    # gathers the evidence that tells them apart and returns something actionable.
    rollback 5 "Build failed" "$(classify_build_failure "${BUILD_OUTPUT}" "${AVAILABLE_MB}" "${BUILD_START}")"
    exit 1
fi
log "Build successful"

# Step 6: Restart service
write_status 6 "Restarting service..." "in_progress"
log "Step 6: Restarting service"
# Belt and braces: reconcile ownership once more before handing back control,
# in case any step above left a root-owned artefact behind.
ensure_ownership
restart_app
log "Service restart issued"

# Step 7: Verify service is running
write_status 7 "Verifying service..." "in_progress"
log "Step 7: Verifying service"
sleep 3

SERVICE_OK=false
for i in $(seq 1 5); do
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000" 2>/dev/null | grep -qE "^(200|302|307)$"; then
        SERVICE_OK=true
        break
    fi
    log "Service not responding yet (attempt ${i}/5), waiting..."
    sleep 2
done

if [ "$SERVICE_OK" = false ]; then
    log "Service health check failed after restart"
    rollback 7 "Service failed to start after update"
    exit 1
fi
log "Service is running and responding"

# Step 8: Clean up backup
write_status 8 "Cleaning up..." "in_progress"
log "Step 8: Cleaning up backup"
rm -rf "${BACKUP_DIR}"
log "Backup cleaned up"

log "=== Update complete: ${OLD_VERSION} → ${NEW_VERSION} ==="
write_status 8 "Update complete" "complete" ",\"newVersion\":\"${NEW_VERSION}\",\"previousVersion\":\"${OLD_VERSION}\""
