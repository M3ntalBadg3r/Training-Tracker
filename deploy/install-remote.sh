#!/bin/bash
set -e

# Training Tracker - Remote Installation Script
# Usage: curl -sSL https://raw.githubusercontent.com/M3ntalBadg3r/Training-Tracker/master/deploy/install-remote.sh | bash
#   Add --dev flag to install the dev channel (tracks the dev branch with pre-releases):
#   curl -sSL https://raw.githubusercontent.com/M3ntalBadg3r/Training-Tracker/master/deploy/install-remote.sh | bash -s -- --dev
# Run as root on a Debian-based system or LXC container.

REPO="https://github.com/M3ntalBadg3r/Training-Tracker.git"
APP_DIR="/opt/training-tracker"
BRANCH="master"
UPDATE_CHANNEL="stable"

# Parse arguments
for arg in "$@"; do
    case "$arg" in
        --dev)
            BRANCH="dev"
            UPDATE_CHANNEL="dev"
            ;;
    esac
done

echo "=== Training Tracker - Remote Install ==="
echo "  Channel: ${UPDATE_CHANNEL}"
echo "  Branch:  ${BRANCH}"
echo ""

# Check for root
if [ "$(id -u)" -ne 0 ]; then
    echo "Error: This script must be run as root."
    exit 1
fi

# Install git if not present
if ! command -v git &> /dev/null; then
    echo "Installing git..."
    apt-get update -qq
    apt-get install -y git
fi

# Clone repository
if [ -d "${APP_DIR}/.git" ]; then
    echo "Existing installation found at ${APP_DIR}."
    echo "To update, run: bash ${APP_DIR}/deploy/update.sh"
    exit 1
fi

echo "Cloning Training Tracker (${BRANCH} branch)..."
git clone -b "${BRANCH}" "${REPO}" "${APP_DIR}"

# Set UPDATE_CHANNEL in .env (install.sh creates .env, so we append after)
export INSTALL_UPDATE_CHANNEL="${UPDATE_CHANNEL}"

# Run the full installer
cd "${APP_DIR}"
bash deploy/install.sh

# Append UPDATE_CHANNEL to .env if not already present
if [ -f "${APP_DIR}/.env" ] && ! grep -q '^UPDATE_CHANNEL=' "${APP_DIR}/.env"; then
    echo "UPDATE_CHANNEL=\"${UPDATE_CHANNEL}\"" >> "${APP_DIR}/.env"
fi
