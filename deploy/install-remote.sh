#!/bin/bash
set -e

# Training Tracker - Remote Installation Script
# Usage: curl -sSL https://raw.githubusercontent.com/M3ntalBadg3r/Training-Tracker/master/deploy/install-remote.sh | bash
#   Add --dev flag to install the dev channel (tracks the dev branch with pre-releases):
#   curl -sSL https://raw.githubusercontent.com/M3ntalBadg3r/Training-Tracker/master/deploy/install-remote.sh | bash -s -- --dev
# Run as root on a Debian-based system or LXC container.

REPO_BASE="https://github.com/M3ntalBadg3r/Training-Tracker.git"
# If GITHUB_TOKEN is set (required for private repos), embed it in the correct format.
if [ -n "${GITHUB_TOKEN}" ]; then
    REPO="https://x-access-token:${GITHUB_TOKEN}@github.com/M3ntalBadg3r/Training-Tracker.git"
else
    REPO="${REPO_BASE}"
fi
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

# Needs root. A saved-file invocation can re-exec under sudo; a piped
# invocation (curl ... | bash) has no script file to re-exec, so instruct the
# user to pipe into sudo instead.
if [ "$(id -u)" -ne 0 ]; then
    if [ -f "$0" ] && command -v sudo >/dev/null 2>&1; then
        echo "Not running as root — re-executing under sudo..."
        exec sudo -E bash "$0" "$@"
    fi
    echo "ERROR: This script must be run as root." >&2
    echo "       Piped install: curl -sSL <url> | sudo bash" >&2
    echo "       (append '-s -- --dev' after 'sudo bash' for the dev channel)" >&2
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

# Append GITHUB_TOKEN to .env if provided and not already present
if [ -n "${GITHUB_TOKEN}" ] && [ -f "${APP_DIR}/.env" ] && ! grep -q '^GITHUB_TOKEN=' "${APP_DIR}/.env"; then
    echo "GITHUB_TOKEN=\"${GITHUB_TOKEN}\"" >> "${APP_DIR}/.env"
fi
