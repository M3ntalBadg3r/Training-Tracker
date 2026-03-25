#!/bin/bash
set -e

# Training Tracker - Remote Installation Script
# Usage: curl -sSL https://raw.githubusercontent.com/M3ntalBadg3r/Training-Tracker/main/deploy/install-remote.sh | bash
# Run as root on a Debian-based system or LXC container.

REPO="https://github.com/M3ntalBadg3r/Training-Tracker.git"
APP_DIR="/opt/training-tracker"

echo "=== Training Tracker - Remote Install ==="

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

echo "Cloning Training Tracker..."
git clone "${REPO}" "${APP_DIR}"

# Run the full installer
cd "${APP_DIR}"
bash deploy/install.sh
