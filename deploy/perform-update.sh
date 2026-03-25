#!/bin/bash
# Training Tracker - Perform Update with Progress Tracking
# Writes step-by-step progress to .update-status file.
# Run as root.

APP_DIR="${1:-/opt/training-tracker}"
STATUS_FILE="${APP_DIR}/.update-status"
TOTAL_STEPS=6

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
    # Escape quotes in error message
    error=$(echo "$error" | sed 's/"/\\"/g' | tr '\n' ' ')
    write_status "$step" "$message" "error" ",\"error\":\"${error}\""
}

cd "${APP_DIR}" || {
    write_error 0 "Application directory not found" "Directory ${APP_DIR} does not exist"
    exit 1
}

# Step 1: Check for updates
write_status 1 "Checking for updates..." "in_progress"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || {
    write_error 1 "Not a git repository" "The application directory is not a git repository. Cannot update."
    exit 1
}

# Step 2: Pull latest changes
write_status 2 "Pulling latest changes..." "in_progress"
if ! git diff --quiet 2>/dev/null; then
    git stash --quiet 2>/dev/null
fi

PULL_OUTPUT=$(git pull origin "${BRANCH}" 2>&1) || {
    write_error 2 "Failed to pull latest changes" "${PULL_OUTPUT}"
    exit 1
}

# Read new version
NEW_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")

# Step 3: Install dependencies
write_status 3 "Installing dependencies..." "in_progress"
INSTALL_OUTPUT=$(npm install 2>&1) || {
    write_error 3 "Failed to install dependencies" "${INSTALL_OUTPUT}"
    exit 1
}

# Step 4: Run database migrations
write_status 4 "Running database migrations..." "in_progress"
MIGRATE_OUTPUT=$(npx prisma migrate deploy 2>&1) || {
    write_error 4 "Database migration failed" "${MIGRATE_OUTPUT}"
    exit 1
}
npx prisma generate 2>&1 || true

# Step 5: Build application
write_status 5 "Building application..." "in_progress"
BUILD_OUTPUT=$(npm run build 2>&1) || {
    write_error 5 "Build failed" "${BUILD_OUTPUT}"
    exit 1
}

# Step 6: Restart service
write_status 6 "Restarting service..." "in_progress"
if command -v systemctl &> /dev/null; then
    systemctl restart training-tracker 2>/dev/null
elif [ -f /etc/init.d/training-tracker ]; then
    /etc/init.d/training-tracker restart 2>/dev/null
fi

write_status 6 "Update complete" "complete" ",\"newVersion\":\"${NEW_VERSION}\""
