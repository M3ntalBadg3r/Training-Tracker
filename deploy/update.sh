#!/bin/bash
# Training Tracker - Update Script for LXC containers or VMs
# Creates a pre-update backup, performs the update, and automatically
# rolls back on failure.
#
# Runs as root — re-execs under sudo when started by a non-root user (e.g. on a
# VM). Root is needed only for the git operations and the service restart; the
# npm/prisma/build steps are dropped to the service user, so a hostile
# dependency's postinstall script never runs with privilege.

APP_DIR="/opt/training-tracker"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

require_root "$@"

# Bring a pre-2.70 install (app running as root, no service account) up to the
# current model.
ensure_non_root_runtime

BACKUP_DIR="${APP_DIR}/.update-backup"
BEFORE_COMMIT=""
MIGRATIONS_RAN=false

# Load the allow-listed keys from .env (DATABASE_URL and friends) so they reach
# the child processes below. Parsed, never sourced: .env is writable by the
# unprivileged service account, so executing it here would be root code
# execution on demand. See load_env_allowlist in lib/common.sh.
load_env_allowlist

# Make Node trust the system CA bundle (covers SSL-inspecting proxies). New
# installs persist NODE_EXTRA_CA_CERTS in .env; this self-heals older installs
# that predate that so the Prisma engine download during updates still works.
if [ -z "${NODE_EXTRA_CA_CERTS}" ] && [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
fi

# Unset NODE_ENV so npm install includes devDependencies (prisma, dotenv, etc.)
unset NODE_ENV

# --- Rollback ---

rollback() {
    local failed_step="$1"
    local error_msg="$2"

    echo ""
    echo "!!! UPDATE FAILED at step ${failed_step}: ${error_msg}"
    echo "!!! Rolling back..."
    echo ""

    # Restore git state
    if [ -n "$BEFORE_COMMIT" ]; then
        echo "  Restoring git to commit ${BEFORE_COMMIT}..."
        cd "${APP_DIR}"
        git checkout "${BEFORE_COMMIT}" -- . 2>/dev/null
        git checkout "${BRANCH}" 2>/dev/null
        git reset --hard "${BEFORE_COMMIT}" 2>/dev/null
        echo "  Git restored."
    fi

    # Restore database if migrations ran
    if [ "$MIGRATIONS_RAN" = true ] && [ -f "${BACKUP_DIR}/db-pre-update.sql" ]; then
        echo "  Restoring database from backup..."
        if command -v psql &> /dev/null && [ -n "${DATABASE_URL}" ]; then
            if run_as_service_user psql "${DATABASE_URL}" < "${BACKUP_DIR}/db-pre-update.sql" 2>/dev/null; then
                echo "  Database restored."
            else
                echo "  WARNING: Database restore failed — manual intervention may be required."
            fi
        else
            echo "  WARNING: psql not found or DATABASE_URL not set — cannot restore database automatically."
        fi
    fi

    # Restore .next build. Both operations act on a service-user-owned tree, so
    # they drop privilege — root cannot write inside a directory it does not own
    # on a container without an effective CAP_DAC_OVERRIDE.
    if [ -d "${BACKUP_DIR}/.next" ]; then
        echo "  Restoring previous build..."
        run_as_service_user rm -rf "${APP_DIR}/.next"
        run_as_service_user cp -r "${BACKUP_DIR}/.next" "${APP_DIR}/.next"
        echo "  Build restored."
    fi

    # The restored tree was written by root; hand it back before restarting.
    ensure_ownership

    # Regenerate Prisma client for restored schema
    echo "  Regenerating Prisma client..."
    cd "${APP_DIR}" && run_as_service_user npx prisma generate 2>/dev/null || true

    # Restart service with old build
    echo "  Restarting service with previous version..."
    restart_app

    echo ""
    echo "=== Rollback Complete ==="
    echo "The update has been rolled back to the previous version."
    exit 1
}

# --- Main ---

echo "=== Training Tracker - Updating ==="
echo ""

cd "${APP_DIR}" || {
    echo "ERROR: Application directory ${APP_DIR} not found."
    exit 1
}

# Step 1: Create pre-update backup
echo "[1/7] Creating pre-update backup..."

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || {
    echo "ERROR: Not a git repository. Cannot update."
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
    echo "  Detected detached HEAD — restoring to branch ${BRANCH}"
    git checkout "${BRANCH}" 2>/dev/null || {
        echo "ERROR: Git is in detached HEAD state and could not checkout branch ${BRANCH}."
        echo "       Run manually: cd ${APP_DIR} && git checkout ${BRANCH}"
        exit 1
    }
fi

BEFORE_COMMIT=$(git rev-parse HEAD 2>/dev/null)
OLD_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
echo "  Current version: ${OLD_VERSION}"
echo "  Current commit:  ${BEFORE_COMMIT}"
echo "  Branch:          ${BRANCH}"

rm -rf "${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"

# Backup .next build
if [ -d "${APP_DIR}/.next" ]; then
    echo "  Backing up .next directory..."
    cp -r "${APP_DIR}/.next" "${BACKUP_DIR}/.next"
fi

# Backup database
if command -v pg_dump &> /dev/null; then
    if [ -n "${DATABASE_URL}" ]; then
        echo "  Backing up database..."
        if run_as_service_user pg_dump "${DATABASE_URL}" > "${BACKUP_DIR}/db-pre-update.sql" 2>/dev/null; then
            echo "  Database backup complete ($(du -sh "${BACKUP_DIR}/db-pre-update.sql" 2>/dev/null | cut -f1))"
        else
            echo "  WARNING: Database backup failed — continuing without DB backup."
        fi
    else
        echo "  WARNING: DATABASE_URL not set — skipping DB backup."
    fi
else
    echo "  WARNING: pg_dump not found — skipping DB backup."
fi

echo "  Backup created."

# Step 2: Pull latest changes
echo "[2/7] Pulling latest changes..."

if ! git diff --quiet 2>/dev/null; then
    echo "  Stashing local changes..."
    git stash --quiet 2>/dev/null
fi

# Configure and then verify the remote BEFORE any network operation — the
# branch-switch fetch below is one, and used to run against whatever remote
# happened to be configured.
#
# GITHUB_TOKEN comes out of .env, a file the unprivileged app can write by
# design, and it used to be interpolated straight into the remote URL. See
# checked_github_token in lib/common.sh: a token containing '@' relocates the
# host, so root would pull an attacker's tree and then execute the deploy
# scripts it contained. A token that is not a plausible credential is a hard
# stop, deliberately: continuing would fail the pull anyway and report nothing
# an operator could act on.
if ! REMOTE_REASON=$(ensure_origin_remote); then
    echo "  ${REMOTE_REASON}"
    rollback 2 "Cannot configure the update source"
fi
if ! ORIGIN_REASON=$(verify_origin_host); then
    echo "  Refusing to pull because ${ORIGIN_REASON}"
    rollback 2 "Cannot verify the update source"
fi

# Switch branch if TARGET_BRANCH is set (used by channel switching)
if [ -n "$TARGET_BRANCH" ] && [ "$TARGET_BRANCH" != "$BRANCH" ]; then
    echo "  Switching branch from ${BRANCH} to ${TARGET_BRANCH}..."
    git fetch origin "${TARGET_BRANCH}" 2>/dev/null
    git checkout "${TARGET_BRANCH}" 2>/dev/null || {
        echo "  Branch checkout failed"
        rollback 2 "Failed to switch to branch ${TARGET_BRANCH}"
    }
    BRANCH="${TARGET_BRANCH}"
    echo "  Switched to branch ${BRANCH}"
fi

PULL_OUTPUT=$(git pull origin "${BRANCH}" 2>&1) || {
    echo "  Git pull failed: ${PULL_OUTPUT}"
    rollback 2 "Failed to pull latest changes"
}

# git ran as root, so anything it just wrote is root-owned. Hand the new tree to
# the service user (and re-lock deploy/ + .git) before the unprivileged steps.
ensure_ownership

# Re-apply the deploy layer from the version just pulled, in a *fresh* bash so it
# reads the new lib/common.sh rather than the copy sourced before the pull. This
# is how changes to the unit files or the ownership model actually ship: without
# it they would not take effect until the update after next.
APP_DIR="${APP_DIR}" bash -c '. "$1"; ensure_non_root_runtime' _ "${SCRIPT_DIR}/lib/common.sh" || echo "  WARNING: post-pull deploy refresh failed — unit files may be stale"

NEW_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
echo "  New version: ${NEW_VERSION}"

# Step 3: Install dependencies
echo "[3/7] Installing dependencies..."
INSTALL_OUTPUT=$(run_as_service_user npm install 2>&1) || {
    echo "  npm install failed: ${INSTALL_OUTPUT}"
    rollback 3 "Failed to install dependencies"
}
echo "  Dependencies installed."

# Self-heal npm's optional-dependency bug (npm/cli#4828) on cross-platform
# lockfiles. ensure_native_deps probes both native engines the build needs — see
# lib/common.sh for why probing only lightningcss was not enough.
ensure_native_deps || rollback 3 "The platform-native build engine could not be installed"

# Step 4: Run database migrations
echo "[4/7] Running database migrations..."
MIGRATE_OUTPUT=$(run_as_service_user npx prisma migrate deploy 2>&1) || {
    echo "  Migration failed: ${MIGRATE_OUTPUT}"
    rollback 4 "Database migration failed"
}
MIGRATIONS_RAN=true

GENERATE_OUTPUT=$(run_as_service_user npx prisma generate 2>&1) || {
    echo "  Prisma generate failed: ${GENERATE_OUTPUT}"
    rollback 4 "Prisma client generation failed"
}
echo "  Migrations applied."

# Step 5: Build application
#
# Mirrors perform-update.sh: a pre-flight that stops the app when memory is
# tight, one retry with the app stopped and the build cache cleared, and a
# classified reason when both attempts fail. See the Build section of
# lib/common.sh for why a failed build says so little on its own.
echo "[5/7] Building application..."

BUILD_START=$(date +%s)
AVAILABLE_MB=$(available_memory_mb)
MIN_MB=$(build_min_mb)
APP_STOPPED=false
echo "  Memory available for the build: ${AVAILABLE_MB} MB (want at least ${MIN_MB} MB)."

if [ "${AVAILABLE_MB}" -lt "${MIN_MB}" ]; then
    echo "  Low memory — stopping the app for the duration of the build."
    stop_app
    APP_STOPPED=true
fi

BUILD_OUTPUT=$(run_as_service_user npm run build 2>&1)
BUILD_RC=$?

if [ "${BUILD_RC}" -ne 0 ]; then
    echo "  Build failed; retrying once with the app stopped and the build cache cleared..."
    capture_panic_logs "${BUILD_START}" "${APP_DIR}/.update-log"
    if [ "${APP_STOPPED}" = false ]; then
        stop_app
        APP_STOPPED=true
    fi
    run_as_service_user rm -rf "${APP_DIR}/.next/cache"

    BUILD_START=$(date +%s)
    AVAILABLE_MB=$(available_memory_mb)
    BUILD_OUTPUT=$(run_as_service_user npm run build 2>&1)
    BUILD_RC=$?
fi

if [ "${BUILD_RC}" -ne 0 ]; then
    echo "${BUILD_OUTPUT}"
    capture_panic_logs "${BUILD_START}" "${APP_DIR}/.update-log"
    rollback 5 "$(classify_build_failure "${BUILD_OUTPUT}" "${AVAILABLE_MB}" "${BUILD_START}")"
fi
echo "  Build successful."

# Step 6: Restart service
echo "[6/7] Restarting service..."
# Belt and braces: reconcile ownership once more before handing back control.
ensure_ownership
if command -v systemctl &> /dev/null || [ -x /etc/init.d/training-tracker ]; then
    restart_app
else
    echo "  No service manager found. Restart manually:"
    echo "    cd ${APP_DIR} && NODE_ENV=production npm start"
fi

# Verify service is running
echo "  Verifying service..."
sleep 3

SERVICE_OK=false
for i in $(seq 1 5); do
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000" 2>/dev/null | grep -qE "^(200|302|307)$"; then
        SERVICE_OK=true
        break
    fi
    echo "  Service not responding yet (attempt ${i}/5), waiting..."
    sleep 2
done

if [ "$SERVICE_OK" = false ]; then
    rollback 6 "Service failed to start after update"
fi
echo "  Service is running."

# Step 7: Clean up backup
echo "[7/7] Cleaning up..."
rm -rf "${BACKUP_DIR}"

echo ""
echo "=== Update Complete: ${OLD_VERSION} → ${NEW_VERSION} ==="
echo "Training Tracker has been updated and restarted."
