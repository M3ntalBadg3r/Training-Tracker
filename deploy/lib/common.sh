#!/bin/bash
# Training Tracker - shared install/update primitives
#
# Sourced by install.sh, update.sh, perform-update.sh and update-agent.sh.
#
# Every function here is idempotent, which is what makes this file double as the
# migration path: an existing install that still runs as root picks up the
# service user, the ownership fix and the helper units the next time any of
# those scripts runs, with no manual step.
#
# Design note — why there is no sudoers rule anywhere in this project:
# the app runs unprivileged and must occasionally trigger privileged work
# (an update, a service restart). The obvious mechanisms — a sudoers entry, a
# setuid helper, a polkit rule — all *grant the service user an escalation
# capability*, and each one is an extra package that a minimal Debian LXC
# template may not ship (`sudo` in particular is frequently absent). Instead the
# service asks for the work by writing a request file it already owns, and a
# root-owned systemd path unit picks it up (see update-agent.sh). The service
# user is granted nothing at all, and the mechanism is identical on an LXC and a
# VM with no packages beyond systemd and util-linux.

SVC_USER="${SVC_USER:-training-tracker}"
SVC_GROUP="${SVC_GROUP:-training-tracker}"
APP_DIR="${APP_DIR:-/opt/training-tracker}"
LOG_DIR="${LOG_DIR:-/var/log/training-tracker}"
UPDATE_REQUEST_FILE="${APP_DIR}/.update-request"

# --- Privilege ---------------------------------------------------------------

# Ensure we are root. On an LXC the operator is normally root already; on a VM
# they usually log in as a regular user, so re-exec under sudo when it exists.
# sudo is only ever used here, for the human-invoked entry points — never as the
# running service's escalation path.
require_root() {
    [ "$(id -u)" -eq 0 ] && return 0

    if [ -f "$0" ] && command -v sudo >/dev/null 2>&1; then
        echo "Not running as root — re-executing under sudo..."
        exec sudo -E bash "$0" "$@"
    fi

    echo "ERROR: This script must be run as root." >&2
    if [ ! -f "$0" ]; then
        echo "       Piped install: curl -sSL <url> | sudo bash" >&2
    else
        echo "       Re-run as root, or install sudo." >&2
    fi
    exit 1
}

# Report every missing dependency at once, before doing any work.
#
# This exists because the failure this whole design guards against is exactly
# "the mechanism assumed a package that wasn't installed". Checking up front and
# naming the Debian package makes that class of bug loud instead of silent.
check_dependencies() {
    local missing=() warn=()

    command -v chown   >/dev/null 2>&1 || missing+=("chown       (coreutils)")
    command -v install >/dev/null 2>&1 || missing+=("install     (coreutils)")
    command -v stat    >/dev/null 2>&1 || missing+=("stat        (coreutils)")

    if ! command -v useradd >/dev/null 2>&1 && ! command -v adduser >/dev/null 2>&1; then
        missing+=("useradd or adduser (passwd / adduser)")
    fi
    if ! command -v runuser >/dev/null 2>&1 && ! command -v su >/dev/null 2>&1; then
        missing+=("runuser or su (util-linux)")
    fi

    # Optional: the app degrades rather than fails without these.
    command -v systemctl >/dev/null 2>&1 || warn+=("systemctl — falling back to the init.d service")
    command -v crontab   >/dev/null 2>&1 || warn+=("crontab — scheduled backups will not run")
    command -v git       >/dev/null 2>&1 || warn+=("git — in-app updates will not work")

    if [ ${#missing[@]} -gt 0 ]; then
        echo "ERROR: required commands are missing:" >&2
        printf '  - %s\n' "${missing[@]}" >&2
        echo "Install them and re-run." >&2
        exit 1
    fi
    if [ ${#warn[@]} -gt 0 ]; then
        echo "Note: optional components unavailable:"
        printf '  - %s\n' "${warn[@]}"
    fi
}

# --- Service account ---------------------------------------------------------

# Create the unprivileged system account the app runs as. No login shell, home
# set to APP_DIR so npm's cache and git's config land somewhere it can write.
ensure_service_user() {
    if id -u "${SVC_USER}" >/dev/null 2>&1; then
        return 0
    fi

    echo "Creating service account ${SVC_USER}..."
    local shell="/usr/sbin/nologin"
    [ -x "${shell}" ] || shell="/bin/false"

    if command -v useradd >/dev/null 2>&1; then
        groupadd --system "${SVC_GROUP}" 2>/dev/null || true
        useradd --system \
                --gid "${SVC_GROUP}" \
                --home-dir "${APP_DIR}" \
                --no-create-home \
                --shell "${shell}" \
                "${SVC_USER}"
    else
        adduser --system --group --no-create-home \
                --home "${APP_DIR}" --shell "${shell}" "${SVC_USER}"
    fi
}

# Hand the application directory to the service user, with two carve-outs.
#
# deploy/ and .git stay root-owned and not group/other-writable, because root
# executes deploy/update-agent.sh and deploy/perform-update.sh via the helper
# unit — if the app could rewrite those, an RCE in the app would be a direct
# route to root and the whole design would be pointless.
#
# Locking the *contents* of deploy/ is not enough on its own: write permission
# on the parent directory is what governs renaming and deleting entries, so a
# service user owning APP_DIR could simply move deploy/ aside and drop in its
# own. Hence APP_DIR itself is root-owned and carries the sticky bit (1775,
# the /tmp pattern): the service user can still create and remove its own
# top-level state files (.update-status, .update-request, .auto-*.json, .env),
# but cannot touch entries owned by root, and cannot clear the sticky bit
# because it does not own the directory.
#
# .env is 0600 and service-owned: the app rewrites it when the update channel
# is switched, and systemd reads EnvironmentFile= as root regardless of mode.
ensure_ownership() {
    [ -d "${APP_DIR}" ] || return 0
    id -u "${SVC_USER}" >/dev/null 2>&1 || return 0

    chown -R "${SVC_USER}:${SVC_GROUP}" "${APP_DIR}"

    # Carve-outs, applied after the blanket chown so a re-run always re-locks
    # them (git pull runs as root and recreates files under both paths).
    local locked
    for locked in deploy .git; do
        if [ -e "${APP_DIR}/${locked}" ]; then
            chown -R root:root "${APP_DIR}/${locked}"
            chmod -R go-w "${APP_DIR}/${locked}"
        fi
    done

    # Root-owned, group-writable, sticky — see the comment above.
    chown "root:${SVC_GROUP}" "${APP_DIR}"
    chmod 1775 "${APP_DIR}"

    if [ -f "${APP_DIR}/.env" ]; then
        chown "${SVC_USER}:${SVC_GROUP}" "${APP_DIR}/.env"
        chmod 600 "${APP_DIR}/.env"
    fi
}

ensure_log_dir() {
    install -d -o "${SVC_USER}" -g "${SVC_GROUP}" -m 0755 "${LOG_DIR}" 2>/dev/null || {
        mkdir -p "${LOG_DIR}"
        chown "${SVC_USER}:${SVC_GROUP}" "${LOG_DIR}" 2>/dev/null || true
    }
}

# When /etc/cron.allow exists, cron becomes an allow-list and the service user
# would silently be unable to install its own crontab. Only touch the file if
# it is already present — creating it would lock out every other user.
ensure_cron_allow() {
    [ -f /etc/cron.allow ] || return 0
    grep -qx "${SVC_USER}" /etc/cron.allow && return 0
    echo "${SVC_USER}" >> /etc/cron.allow
    echo "Added ${SVC_USER} to /etc/cron.allow"
}

# Run a command as the service user, preserving the environment the build steps
# depend on. runuser and su reset PATH and HOME from /etc/login.defs, which
# would break `npx` and send npm's cache somewhere unwritable — hence the
# explicit `env` prefix rather than relying on inheritance.
run_as_service_user() {
    if [ "$(id -u)" -ne 0 ] || ! id -u "${SVC_USER}" >/dev/null 2>&1; then
        # Already unprivileged, or the account does not exist yet (an old
        # install part-way through migrating). Run as-is.
        "$@"
        return $?
    fi

    local envs=("HOME=${APP_DIR}" "PATH=${PATH}")
    local var
    for var in DATABASE_URL NODE_EXTRA_CA_CERTS TARGET_BRANCH GITHUB_TOKEN UPDATE_CHANNEL npm_config_cache; do
        if [ -n "${!var:-}" ]; then
            envs+=("${var}=${!var}")
        fi
    done

    if command -v runuser >/dev/null 2>&1; then
        runuser -u "${SVC_USER}" -- env "${envs[@]}" "$@"
        return $?
    fi

    # su takes a command string rather than an argv, so quote each element.
    local quoted
    quoted="$(printf '%q ' env "${envs[@]}" "$@")"
    su -s /bin/bash -c "${quoted}" "${SVC_USER}"
}

# --- systemd -----------------------------------------------------------------

# Install the service unit plus the root-owned update helper (a .path unit
# watching for the request file, and the oneshot it triggers).
install_units() {
    command -v systemctl >/dev/null 2>&1 || return 0

    local src="${APP_DIR}/deploy"
    local unit
    for unit in training-tracker.service training-tracker-update.service training-tracker-update.path; do
        if [ -f "${src}/${unit}" ]; then
            install -m 0644 -o root -g root "${src}/${unit}" "/etc/systemd/system/${unit}"
        fi
    done

    systemctl daemon-reload
    # Enable the watcher, never the oneshot — that one is triggered, not booted.
    systemctl enable training-tracker-update.path >/dev/null 2>&1 || true
    systemctl start  training-tracker-update.path >/dev/null 2>&1 || true
}

# Restart the app, whichever init system is in play.
restart_app() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl restart training-tracker 2>/dev/null
    elif [ -x /etc/init.d/training-tracker ]; then
        /etc/init.d/training-tracker restart
    fi
}

# --- Cron -------------------------------------------------------------------

# Install the fixed scheduled jobs, root-owned, so the app never has to edit a
# crontab it has no privilege to write.
ensure_cron_jobs() {
    [ -d /etc/cron.d ] || return 0

    cat > /etc/cron.d/training-tracker << CRONEOF
# Training Tracker scheduled jobs. Managed by deploy/ — edits here are
# overwritten on the next install or update. Schedules are set in the app.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

*/5 * * * * root bash ${APP_DIR}/deploy/auto-update.sh ${APP_DIR}
* * * * * ${SVC_USER} bash ${APP_DIR}/deploy/auto-export.sh ${APP_DIR}
0 6 * * * ${SVC_USER} bash ${APP_DIR}/deploy/auto-credential-check.sh ${APP_DIR}
CRONEOF
    chmod 0644 /etc/cron.d/training-tracker

    # Pre-2.70 installs had the app (running as root) write these two entries
    # into root's crontab. The cron.d file above now covers both, so leaving
    # them would double up — auto-export in particular would fire twice a
    # minute. The auto-backup entry is deliberately left alone: its schedule is
    # still app-managed and removing it here would silently stop backups.
    command -v crontab >/dev/null 2>&1 || return 0
    local current
    current="$(crontab -l 2>/dev/null || true)"
    case "${current}" in
        *training-tracker-auto-update*|*training-tracker-auto-export*)
            echo "Removing superseded root crontab entries (now in /etc/cron.d)..."
            printf '%s\n' "${current}" \
                | grep -v 'training-tracker-auto-update' \
                | grep -v 'training-tracker-auto-export' \
                | crontab - 2>/dev/null || true
            ;;
    esac
}

# True when this install has not yet been moved to the unprivileged model.
# Deliberately cheap: it is polled from cron, and the repair it gates chowns the
# whole tree (node_modules included), which must not run every five minutes.
needs_non_root_migration() {
    id -u "${SVC_USER}" >/dev/null 2>&1 || return 0
    if command -v systemctl >/dev/null 2>&1 &&
       [ ! -f /etc/systemd/system/training-tracker-update.path ]; then
        return 0
    fi
    return 1
}

# Bring an install up to the current privilege model. Safe to call repeatedly.
ensure_non_root_runtime() {
    ensure_service_user
    ensure_log_dir
    ensure_cron_allow
    ensure_ownership
    install_units
    ensure_cron_jobs
}
