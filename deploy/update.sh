#!/bin/bash
# Training Tracker - Update Script for LXC containers
# Creates a pre-update backup, performs the update, and automatically
# rolls back on failure.
# Run as root

APP_DIR="/opt/training-tracker"
BACKUP_DIR="${APP_DIR}/.update-backup"
BEFORE_COMMIT=""
MIGRATIONS_RAN=false

# Source .env so DATABASE_URL (and other vars) are available
if [ -f "${APP_DIR}/.env" ]; then
    set -a
    source "${APP_DIR}/.env"
    set +a
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
        git checkout "${BEFORE_COMMIT}" 2>/dev/null
        echo "  Git restored."
    fi

    # Restore database if migrations ran
    if [ "$MIGRATIONS_RAN" = true ] && [ -f "${BACKUP_DIR}/db-pre-update.sql" ]; then
        echo "  Restoring database from backup..."
        if command -v psql &> /dev/null && [ -n "${DATABASE_URL}" ]; then
            if psql "${DATABASE_URL}" < "${BACKUP_DIR}/db-pre-update.sql" 2>/dev/null; then
                echo "  Database restored."
            else
                echo "  WARNING: Database restore failed — manual intervention may be required."
            fi
        else
            echo "  WARNING: psql not found or DATABASE_URL not set — cannot restore database automatically."
        fi
    fi

    # Restore .next build
    if [ -d "${BACKUP_DIR}/.next" ]; then
        echo "  Restoring previous build..."
        rm -rf "${APP_DIR}/.next"
        cp -r "${BACKUP_DIR}/.next" "${APP_DIR}/.next"
        echo "  Build restored."
    fi

    # Regenerate Prisma client for restored schema
    echo "  Regenerating Prisma client..."
    cd "${APP_DIR}" && npx prisma generate 2>/dev/null || true

    # Restart service with old build
    echo "  Restarting service with previous version..."
    if command -v systemctl &> /dev/null; then
        systemctl restart training-tracker 2>/dev/null
    elif [ -f /etc/init.d/training-tracker ]; then
        /etc/init.d/training-tracker restart 2>/dev/null
    fi

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
        if pg_dump "${DATABASE_URL}" > "${BACKUP_DIR}/db-pre-update.sql" 2>/dev/null; then
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

PULL_OUTPUT=$(git pull origin "${BRANCH}" 2>&1) || {
    echo "  Git pull failed: ${PULL_OUTPUT}"
    rollback 2 "Failed to pull latest changes"
}

NEW_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
echo "  New version: ${NEW_VERSION}"

# Step 3: Install dependencies
echo "[3/7] Installing dependencies..."
INSTALL_OUTPUT=$(npm install 2>&1) || {
    echo "  npm install failed: ${INSTALL_OUTPUT}"
    rollback 3 "Failed to install dependencies"
}
echo "  Dependencies installed."

# Step 4: Run database migrations
echo "[4/7] Running database migrations..."
MIGRATE_OUTPUT=$(npx prisma migrate deploy 2>&1) || {
    echo "  Migration failed: ${MIGRATE_OUTPUT}"
    rollback 4 "Database migration failed"
}
MIGRATIONS_RAN=true

GENERATE_OUTPUT=$(npx prisma generate 2>&1) || {
    echo "  Prisma generate failed: ${GENERATE_OUTPUT}"
    rollback 4 "Prisma client generation failed"
}
echo "  Migrations applied."

# Step 5: Build application
echo "[5/7] Building application..."
BUILD_OUTPUT=$(npm run build 2>&1) || {
    echo "  Build failed: ${BUILD_OUTPUT}"
    rollback 5 "Build failed"
}
echo "  Build successful."

# Step 6: Restart service
echo "[6/7] Restarting service..."
if command -v systemctl &> /dev/null; then
    systemctl restart training-tracker 2>/dev/null
elif [ -f /etc/init.d/training-tracker ]; then
    /etc/init.d/training-tracker restart 2>/dev/null
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
