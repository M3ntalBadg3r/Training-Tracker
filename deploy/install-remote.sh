#!/bin/bash
set -e

# Training Tracker - Remote Installation Script
# Usage: curl -sSL https://raw.githubusercontent.com/M3ntalBadg3r/Training-Tracker/master/deploy/install-remote.sh | bash
#   Add --dev flag to install the dev channel (tracks the dev branch with pre-releases):
#   curl -sSL https://raw.githubusercontent.com/M3ntalBadg3r/Training-Tracker/master/deploy/install-remote.sh | bash -s -- --dev
# Run as root on a Debian-based system or LXC container.

REPO_BASE="https://github.com/M3ntalBadg3r/Training-Tracker.git"
# If GITHUB_TOKEN is set (required for private repos), embed it in the correct format.
#
# Why this is not the same thing as building a remote URL inside the update
# scripts, which is deliberately not done any more:
#
#   - There, the token is read out of ${APP_DIR}/.env, a file the unprivileged
#     application account can rewrite. After a compromise of the app the value
#     is attacker-chosen, and because a URL parser ends the userinfo at the
#     first '@', a token containing one moves the HOST — so root would pull a
#     tree of the attacker's choosing and then run the deploy scripts out of it.
#     lib/common.sh therefore charset-checks the token and re-verifies the host
#     of the remote before every fetch.
#   - Here, nothing of this install exists yet: there is no .env, no application
#     and no service account. The value comes from the environment of the
#     operator who is, at this moment, running a script as root — they are
#     already the trusted party, and anything they could achieve by reshaping
#     this URL they could achieve by editing the next line.
#
# So this instance is left alone on purpose. Do not "fix" it by copying the
# checks from lib/common.sh, and do not copy THIS pattern into anything that
# runs after the install: by then the value has an untrusted source.
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
        # A closed list rather than `sudo -E`, for the reason given in
        # require_root in lib/common.sh: the whole caller environment should not
        # cross into the root process just because one command was permitted.
        # These four are the ones this bootstrap documents.
        if sudo --help 2>&1 | grep -q -- '--preserve-env=list'; then
            exec sudo --preserve-env=GITHUB_TOKEN,APP_BASE_URL,TRUSTED_PROXIES,UPDATE_CHANNEL bash "$0" "$@"
        fi
        exec sudo bash "$0" "$@"
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
