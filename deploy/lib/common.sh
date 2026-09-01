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
# .env and the two update state files are the exception to "the service user owns
# the tree" — see the comments on each below. systemd reads EnvironmentFile= as
# root regardless of mode, so tightening .env costs nothing.
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

    # .env is written by root (install.sh appends missing keys) *and* by the app
    # (the update-channel switch), so it follows the same rule as the state files
    # below: root owns it, the service user reaches it through the group. 0660
    # keeps it as private as the old 0600 did — only root and the service account
    # are in that group.
    if [ -f "${APP_DIR}/.env" ]; then
        chown "root:${SVC_GROUP}" "${APP_DIR}/.env"
        chmod 0660 "${APP_DIR}/.env"
    fi

    # Must come last: the blanket chown above would otherwise hand these to the
    # service user, which is exactly what breaks root's writes to them.
    ensure_state_file "${APP_DIR}/.update-status" "${APP_DIR}/.update-log"
}

# Files that BOTH root and the app write: update progress and the update log.
#
# These are root-owned and group-writable, and that detail is load-bearing.
# Do NOT "simplify" it by giving them to the service user like everything else
# in the tree. On a container whose root lacks an effective CAP_DAC_OVERRIDE —
# an unprivileged LXC, i.e. a platform this project explicitly targets — root
# cannot write a file it does not own. When these were service-user-owned,
# every log() and write_status() call in perform-update.sh failed with
# "Permission denied", updates ran to completion with the UI frozen on step 0,
# and nothing was recorded anywhere the operator would look.
#
# Root owns them and writes as owner; the app writes through the group. The
# corollary is that the app cannot *unlink* them (APP_DIR is sticky and they are
# root-owned), so the ack path in api/admin/updates/status truncates to an idle
# payload instead of deleting.
ensure_state_file() {
    local f
    for f in "$@"; do
        [ -e "${f}" ] || : > "${f}"
        chown "root:${SVC_GROUP}" "${f}" 2>/dev/null || true
        chmod 0664 "${f}" 2>/dev/null || true
    done
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

# Stop the app, whichever init system is in play.
#
# Used by the update scripts to hand the running app's memory back to the kernel
# before a production build on a constrained host — see available_memory_mb.
# Every path that stops the app calls restart_app afterwards (step 6 on success,
# rollback on failure), so this never leaves the service down.
stop_app() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl stop training-tracker 2>/dev/null
    elif [ -x /etc/init.d/training-tracker ]; then
        /etc/init.d/training-tracker stop
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

# --- Build -------------------------------------------------------------------
#
# Everything below exists because of one failure mode: a production build dying
# without saying why. Turbopack runs PostCSS (Tailwind) in a child process, so
# both of the realistic causes — the child being OOM-killed, and the native
# engine failing to load — surface identically, as the child vanishing mid-IPC:
#
#   [project]/src/app/globals.css [app-client] (css)
#    - Execution of evaluate_webpack_loader failed
#    - failed to receive message / reading packet length / unexpected end of file
#
# globals.css is named only because it is the sole file that goes through
# PostCSS. Nothing in that text distinguishes the two causes, so the helpers
# here gather the evidence that does.

# Memory (MiB) a production build is assumed to need. Below this the update
# scripts stop the app for the duration of the build rather than let the kernel
# pick which process to kill. A function rather than a constant so a value set in
# .env still applies — .env is sourced after this file.
build_min_mb() { echo "${TT_BUILD_MIN_MB:-2048}"; }

# Memory available to a build here, in MiB: MemAvailable + SwapFree, clamped by
# the cgroup's own headroom when this is running inside one.
#
# The clamp is the whole point. Inside an LXC /proc/meminfo reports the *host's*
# memory, so a 2 GB container reads back as whatever the host has — and the
# check would pass on exactly the systems that cannot complete a build. Both
# cgroup versions report a sentinel ("max", or a huge number) when unlimited,
# which is why the limit is only applied when it parses as a number and comes
# out lower than /proc/meminfo's figure.
available_memory_mb() {
    local avail=0 swap=0 total limit used headroom

    if [ -r /proc/meminfo ]; then
        avail=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
        swap=$(awk '/^SwapFree:/ {print int($2/1024)}' /proc/meminfo)
    fi
    total=$(( ${avail:-0} + ${swap:-0} ))

    limit=""
    if [ -r /sys/fs/cgroup/memory.max ] && [ -r /sys/fs/cgroup/memory.current ]; then
        limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)
        used=$(cat /sys/fs/cgroup/memory.current 2>/dev/null)
    elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ] &&
         [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then
        limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)
        used=$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null)
    fi

    case "${limit}" in
        ''|*[!0-9]*) ;;                     # absent, or "max" — no cgroup cap
        *)
            case "${used}" in ''|*[!0-9]*) used=0 ;; esac
            headroom=$(( (limit - used) / 1024 / 1024 ))
            if [ "${headroom}" -ge 0 ] && [ "${headroom}" -lt "${total}" ]; then
                total="${headroom}"
            fi
            ;;
    esac

    echo "${total}"
}

# Do the platform-native build engines actually load?
#
# npm's optional-dependency bug (npm/cli#4828) can leave a platform's native
# binary uninstalled when the committed package-lock.json was generated on a
# different OS/arch. TWO separate packages matter and both must be probed:
#
#   lightningcss        — the CSS minifier
#   @tailwindcss/oxide  — Tailwind v4's native engine, which @tailwindcss/postcss
#                         is the thing that actually loads
#
# Probing only lightningcss (as the three deploy scripts each did, in three
# copies, before 2.76) misses the oxide case completely — and that is the case
# that produces the unreadable Turbopack panic described at the top of this
# section. Probes run as the service user from APP_DIR so they resolve
# node_modules exactly as the build will.
native_deps_ok() {
    ( cd "${APP_DIR}" 2>/dev/null &&
      run_as_service_user node -e "require('lightningcss');require('@tailwindcss/oxide')" \
    ) >/dev/null 2>&1
}

# Verify the native engines and, if they are missing, regenerate the lockfile for
# this platform and reinstall. Returns non-zero if the repair did not take.
ensure_native_deps() {
    native_deps_ok && return 0

    echo "Native build engine missing for this platform; reinstalling dependencies..."
    # node_modules and the lockfile belong to the service user; root cannot
    # delete inside a directory it does not own on a container without an
    # effective CAP_DAC_OVERRIDE.
    ( cd "${APP_DIR}" && run_as_service_user rm -rf node_modules package-lock.json ) || return 1
    ( cd "${APP_DIR}" && run_as_service_user npm install ) || return 1

    native_deps_ok
}

# Copy any Next.js panic dumps written since <epoch seconds> into <logfile>.
#
# A Turbopack panic writes its detail to /tmp/next-panic-<hash>.log and prints
# only the path, so the build output on its own says almost nothing. /tmp is
# cleared on reboot: unless the dump is copied somewhere durable at the moment it
# happens, the one artefact that explains the failure is gone before anyone looks.
capture_panic_logs() {
    local since="$1" dest="$2" f

    [ -n "${dest}" ] && [ -w "${dest}" ] || return 0
    [ -d /tmp ] || return 0

    while IFS= read -r f; do
        [ -f "${f}" ] || continue
        {
            echo "--- begin ${f} ---"
            head -c 8000 "${f}"
            echo ""
            echo "--- end ${f} ---"
        } >> "${dest}"
    done < <(find /tmp -maxdepth 1 -name 'next-panic-*.log' -newermt "@${since}" 2>/dev/null)

    return 0
}

# Did the kernel OOM-kill anything since <epoch seconds>? Best-effort: journalctl
# is absent on some hosts and dmesg is unavailable in most containers, so a
# negative answer is not evidence of anything — it only ever adds confidence.
recent_oom_kill() {
    local since="$1"

    if command -v journalctl >/dev/null 2>&1; then
        journalctl -k --since "@${since}" 2>/dev/null \
            | grep -qiE "out of memory: killed|oom-kill" && return 0
    fi
    if command -v dmesg >/dev/null 2>&1; then
        dmesg 2>/dev/null | tail -n 200 \
            | grep -qiE "out of memory: killed|oom-kill" && return 0
    fi
    return 1
}

# Turn a failed build into one sentence an operator can act on. This is what
# reaches the admin UI, via the "error" field of .update-status.
#
# Ordering matters, for the reason given at the top of this section: a missing
# native engine and an OOM kill produce the same Turbopack text. So test the
# engines first — that cause can be proven — and only then weigh the memory
# evidence. Note the build output usually will NOT contain "Killed": it is the
# child process the kernel takes, not the npm process whose output we captured,
# which is why the measured-memory branch has to exist at all.
#
# Keep the result well under the 2000-character truncation in write_error.
classify_build_failure() {
    local output="$1" mem="${2:-}" since="${3:-0}" min

    if ! native_deps_ok; then
        echo "Build failed: the platform-native build engine (lightningcss / @tailwindcss/oxide) could not be loaded. Reinstall dependencies as the service user: cd ${APP_DIR} && runuser -u ${SVC_USER} -- rm -rf node_modules package-lock.json && runuser -u ${SVC_USER} -- npm install"
        return 0
    fi

    case "${output}" in
        *"JavaScript heap out of memory"*|*"out of memory"*|*"Out of memory"*|*"Killed"*|*"signal: 9"*)
            echo "Build ran out of memory (${mem:-unknown} MB available at the time). Add RAM or swap to this system, then retry the update. Full build output is in .update-log."
            return 0
            ;;
    esac

    if recent_oom_kill "${since}"; then
        echo "Build failed and the kernel OOM-killed a process during it (${mem:-unknown} MB available). Add RAM or swap to this system, then retry the update. Full build output is in .update-log."
        return 0
    fi

    min="$(build_min_mb)"
    if [ -n "${mem}" ] && [ "${mem}" -lt "${min}" ] 2>/dev/null; then
        echo "Build failed, most likely out of memory: ${mem} MB was available and a production build needs roughly ${min} MB. Add RAM or swap, then retry the update. Full build output is in .update-log."
        return 0
    fi

    echo "Build failed. See ${APP_DIR}/.update-log for the full build output and any captured Next.js panic dump."
}
