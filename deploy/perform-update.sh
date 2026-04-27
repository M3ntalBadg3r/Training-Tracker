#!/bin/bash
# Training Tracker - Perform Update with Progress Tracking & Rollback
# Creates a pre-update backup, performs the update, and automatically
# rolls back on failure. Writes progress to .update-status and a
# detailed log to .update-log.
# Run as root.

APP_DIR="${1:-/opt/training-tracker}"
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

# Unset NODE_ENV so npm install includes devDependencies (prisma, dotenv, etc.)
unset NODE_ENV

BEFORE_COMMIT=""
MIGRATIONS_RAN=false

# --- Logging ---

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

    # Restore database if migrations ran
    if [ "$MIGRATIONS_RAN" = true ] && [ -f "${BACKUP_DIR}/db-pre-update.sql" ]; then
        log "Restoring database from backup..."
        if command -v psql &> /dev/null && [ -n "${DATABASE_URL}" ]; then
            psql "${DATABASE_URL}" < "${BACKUP_DIR}/db-pre-update.sql" 2>> "${LOG_FILE}" && \
                log "Database restored successfully" || \
                log "WARNING: Database restore failed — manual intervention may be required"
        else
            log "WARNING: psql not found or DATABASE_URL not set — cannot restore database automatically"
        fi
    fi

    # Restore .next build
    if [ -d "${BACKUP_DIR}/.next" ]; then
        log "Restoring previous build..."
        rm -rf "${APP_DIR}/.next"
        cp -r "${BACKUP_DIR}/.next" "${APP_DIR}/.next"
        log "Build restored"
    fi

    # Regenerate Prisma client for restored schema
    log "Regenerating Prisma client..."
    cd "${APP_DIR}" && npx prisma generate 2>> "${LOG_FILE}" || true

    # Restart service with old build
    log "Restarting service with previous version..."
    if command -v systemctl &> /dev/null; then
        systemctl restart training-tracker 2>/dev/null
    elif [ -f /etc/init.d/training-tracker ]; then
        /etc/init.d/training-tracker restart 2>/dev/null
    fi

    log "=== ROLLBACK COMPLETE ==="
    write_error "$failed_step" "$error_msg" "Update failed and was rolled back automatically. Check the update log for details."
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
        pg_dump "${DATABASE_URL}" > "${BACKUP_DIR}/db-pre-update.sql" 2>> "${LOG_FILE}" && \
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

NEW_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
log "New version: ${NEW_VERSION}"

# Step 3: Install dependencies
write_status 3 "Installing dependencies..." "in_progress"
log "Step 3: Installing dependencies"
INSTALL_OUTPUT=$(npm install 2>&1) || {
    log "npm install failed: ${INSTALL_OUTPUT}"
    rollback 3 "Failed to install dependencies"
    exit 1
}
log "Dependencies installed"

# Step 4: Run database migrations
write_status 4 "Running database migrations..." "in_progress"
log "Step 4: Running database migrations"
MIGRATE_OUTPUT=$(npx prisma migrate deploy 2>&1) || {
    log "Migration failed: ${MIGRATE_OUTPUT}"
    rollback 4 "Database migration failed"
    exit 1
}
MIGRATIONS_RAN=true
log "Migrations applied"

GENERATE_OUTPUT=$(npx prisma generate 2>&1) || {
    log "Prisma generate failed: ${GENERATE_OUTPUT}"
    rollback 4 "Prisma client generation failed"
    exit 1
}
log "Prisma client generated"

# Step 5: Build application
write_status 5 "Building application..." "in_progress"
log "Step 5: Building application"
BUILD_OUTPUT=$(npm run build 2>&1) || {
    log "Build failed: ${BUILD_OUTPUT}"
    rollback 5 "Build failed"
    exit 1
}
log "Build successful"

# Step 6: Restart service
write_status 6 "Restarting service..." "in_progress"
log "Step 6: Restarting service"
if command -v systemctl &> /dev/null; then
    systemctl restart training-tracker 2>/dev/null
elif [ -f /etc/init.d/training-tracker ]; then
    /etc/init.d/training-tracker restart 2>/dev/null
fi
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
