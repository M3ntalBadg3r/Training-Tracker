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

# --- Configuration -----------------------------------------------------------

# Keys that root legitimately needs out of .env. Nothing outside this list is
# read, so adding a variable here is a deliberate act.
#
# GITHUB_TOKEN stays on the list because a private-repo install cannot update
# without it; removing it would break those operators. The consequence is that
# root handles a string the unprivileged service account can choose, so it is
# never trusted as-is — see checked_github_token below.
ENV_ALLOWED_KEYS="DATABASE_URL GITHUB_TOKEN NODE_EXTRA_CA_CERTS UPDATE_CHANNEL TT_BUILD_MIN_MB npm_config_cache"

# The upstream repository, in one place so the two update scripts cannot drift.
# The host is a literal: it is never assembled from anything read out of .env.
GIT_REMOTE_HOST="github.com"
GIT_REMOTE_PATH="M3ntalBadg3r/Training-Tracker.git"

# Read the allow-listed keys out of ${APP_DIR}/.env and export them.
#
# This deliberately does NOT `source` the file. .env is group-writable by the
# service user (see ensure_ownership) because the app rewrites UPDATE_CHANNEL
# when the operator switches release channels — so `source` would hand the
# unprivileged service arbitrary code execution as root at the next update,
# which is exactly the escalation the request-file design exists to prevent.
# Here the file is only ever *parsed*: values are assigned, never evaluated, so
# `FOO=$(...)`, backticks and bare commands are inert text.
load_env_allowlist() {
    local env_file="${APP_DIR}/.env"
    [ -f "${env_file}" ] || return 0

    local line key value
    while IFS= read -r line || [ -n "${line}" ]; do
        # Tolerate `export KEY=...`, leading whitespace, comments and blanks.
        line="${line#"${line%%[![:space:]]*}"}"
        case "${line}" in
            ''|'#'*) continue ;;
            'export '*) line="${line#export }" ;;
        esac

        key="${line%%=*}"
        # Not a KEY=VALUE line at all, or not a valid shell identifier.
        [ "${key}" != "${line}" ] || continue
        case "${key}" in
            ''|*[!A-Za-z0-9_]*|[0-9]*) continue ;;
        esac

        # Only the keys we asked for.
        case " ${ENV_ALLOWED_KEYS} " in
            *" ${key} "*) ;;
            *) continue ;;
        esac

        value="${line#*=}"
        # Strip one matching layer of surrounding quotes, then trailing CR from
        # a file that has been through a Windows editor.
        case "${value}" in
            \"*\") value="${value#\"}"; value="${value%\"}" ;;
            "'"*"'") value="${value#\'}"; value="${value%\'}" ;;
        esac
        value="${value%$'\r'}"

        # printf -v assigns; it does not evaluate the value.
        printf -v "${key}" '%s' "${value}"
        export "${key?}"
    done < "${env_file}"
}

# --- Git remote --------------------------------------------------------------

# Check GITHUB_TOKEN before anything interpolates it into a URL.
#
# The value reaches root from ${APP_DIR}/.env, and .env is group-writable by the
# *unprivileged* service account by design (the app rewrites UPDATE_CHANNEL
# there when the operator switches release channel). So after an RCE in the app
# this string is attacker-chosen, and the update scripts splice it into
#
#     https://x-access-token:<token>@github.com/<owner>/<repo>.git
#
# A URL parser ends the userinfo at the FIRST '@' in the authority, so a token
# that itself contains '@' moves the HOST: a value of the form
#
#     x<at><host-they-control>/evil.git#
#
# leaves the real '@github.com/...' suffix commented out by the '#', and root
# pulls the attacker's tree over the working copy and then runs the deploy
# scripts that pull just wrote. No race and no pre-existing token needed — the attacker
# supplies the value that activates the branch.
#
# Every real GitHub credential (ghp_/gho_/ghu_/ghs_/ghr_, github_pat_, and the
# legacy 40-hex PAT) is drawn from [A-Za-z0-9_], so refusing anything outside a
# slightly wider set costs a real operator nothing and removes the injection
# entirely: with no '@', '/', ':', '#', '?' or whitespace, the token cannot
# reach out of the userinfo field it sits in.
#
# Echoes the trimmed token and returns 0 when it is plausible; prints nothing
# and returns 1 otherwise. Callers must treat a rejection as fatal — quietly
# carrying on would fail the pull anyway, with a message that explains nothing.
checked_github_token() {
    local token="${1:-}"
    # Surrounding whitespace (a trailing CR from a .env edited on Windows, for
    # instance) is not part of the value. Whitespace *inside* it means this is
    # not a token, and the check below rejects it.
    token="${token#"${token%%[![:space:]]*}"}"
    token="${token%"${token##*[![:space:]]}"}"
    [ -n "${token}" ] || return 1
    [ "${#token}" -le 255 ] || return 1
    case "${token}" in
        *[!A-Za-z0-9_.-]*) return 1 ;;
    esac
    printf '%s' "${token}"
}

# The host component of a git remote URL, extracted the way a URL parser reads
# it: everything between the scheme and the first '/' is the authority, and the
# host is what follows the userinfo inside it. Used to check where root is about
# to pull from, so a reshaped URL is caught however it was reshaped — including
# one an earlier compromise already wrote into .git/config.
#
# Returns 1 for anything that is not a recognisable remote URL. Never echoes the
# URL itself: it carries the credential.
git_remote_host() {
    local url="${1:-}" rest authority host
    # Positive scheme allowlist. Only the transports a real upstream is ever
    # reached over are accepted; anything else is refused rather than parsed.
    # This matters for the transport-helper schemes — ext::, fd::, and friends
    # — where ext:: in particular runs an arbitrary command: an ext:: "URL"
    # embeds a real https:// substring, so the *://* prefix-match below would
    # otherwise dig github.com out of it and wave the whole thing through. Git
    # refuses ext:: by default today (protocol.ext.allow=never), so this is
    # defence in depth, not a live hole — but the check's entire job is to catch
    # a poisoned .git/config, so it must not itself be fooled by one.
    case "${url}" in
        https://*|http://*|ssh://*|git://*|ftp://*|ftps://*|git+ssh://*)
            rest="${url#*://}"
            authority="${rest%%/*}"
            ;;
        *://*)
            # Some other scheme (a transport helper, ext::, …). Not an upstream.
            return 1
            ;;
        *[!A-Za-z0-9._@+~-]*:*)
            # scp-style is user@host:path or host:path, so everything before the
            # first ':' is the authority and may hold only hostname/userinfo
            # characters. A space, a quote or transport-helper syntax before the
            # colon means this is not a git remote to reason about — refuse.
            return 1
            ;;
        *:*)
            # scp-style: user@host:path
            authority="${url%%:*}"
            ;;
        *)
            return 1
            ;;
    esac
    # Userinfo ends at the FIRST '@' — that is how git reads it. If what is left
    # still contains an '@', refuse to guess: git and the libcurl that actually
    # opens the connection disagree on a two-'@' authority (measured: for
    # a:b@one@two git keeps host="one@two" while curl rejects it as a bad
    # hostname), so there is no single answer to compare against a literal.
    case "${authority}" in
        *@*) host="${authority#*@}" ;;
        *)   host="${authority}" ;;
    esac
    case "${host}" in
        *@*) return 1 ;;
    esac
    host="${host%%:*}"          # drop :port
    host="${host%.}"            # a trailing dot is the DNS root label: github.com. == github.com
    # A hostname is letters, digits, dots and hyphens. Anything else is not
    # something to compare against a literal and wave through.
    case "${host}" in
        ''|*[!A-Za-z0-9.-]*) return 1 ;;
    esac
    # Hostnames are case-insensitive and git remote set-url stores them verbatim
    # (a hand clone or a copy-paste can leave GitHub.COM in .git/config), so
    # fold to lower before the caller compares against the lowercase literal.
    printf '%s' "${host,,}"
}

# Point origin at the upstream repository, adding the token credential when the
# operator has configured one for a private repo. A common misconfiguration is
# https://TOKEN@github.com/... (token as username only), which makes git prompt
# for a password and fail in non-interactive contexts — hence the rewrite.
#
# Returns 0 having changed nothing when no token is configured (the normal
# public-repo case). Returns 1 with a one-line reason on stdout when a token is
# present but is not a plausible credential, or when git refuses the rewrite.
ensure_origin_remote() {
    local token safe desired current
    token="${GITHUB_TOKEN:-}"
    # Trim surrounding whitespace up front so a whitespace-only value — a stray
    # space, or a lone CR from a .env edited on Windows — reads as "no token"
    # and takes the return-0 fast path, exactly like an empty GITHUB_TOKEN=.
    # Without this, " " is non-empty here but trims to empty in
    # checked_github_token, turning a blank setting into a hard, rollback-
    # inducing failure. (Whitespace *inside* a token is still a rejection.)
    token="${token#"${token%%[![:space:]]*}"}"
    token="${token%"${token##*[![:space:]]}"}"
    [ -n "${token}" ] || return 0

    if ! safe=$(checked_github_token "${token}"); then
        printf 'GITHUB_TOKEN in .env is not a valid GitHub token — refusing to build a remote URL from it'
        return 1
    fi

    desired="https://x-access-token:${safe}@${GIT_REMOTE_HOST}/${GIT_REMOTE_PATH}"
    current=$(git remote get-url origin 2>/dev/null || echo "")
    if [ "${current}" != "${desired}" ]; then
        git remote set-url origin "${desired}" || {
            printf 'could not set the origin remote URL'
            return 1
        }
    fi
    return 0
}

# Belt to ensure_origin_remote's braces: confirm the remote root is about to
# pull from really is the upstream host, whatever put it there. This is what
# catches a .git/config poisoned before this check existed, and any future
# reintroduction of a URL built from untrusted input.
#
# Returns 1 with a one-line reason on stdout (host only — never the URL).
verify_origin_host() {
    local url host
    url=$(git remote get-url origin 2>/dev/null) || {
        printf 'the origin remote has no URL'
        return 1
    }
    if ! host=$(git_remote_host "${url}"); then
        printf 'the origin remote URL is not a recognisable git URL'
        return 1
    fi
    if [ "${host}" != "${GIT_REMOTE_HOST}" ]; then
        printf 'the origin remote points at %s, not %s' "${host}" "${GIT_REMOTE_HOST}"
        return 1
    fi
    return 0
}

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
    command -v crontab   >/dev/null 2>&1 || warn+=("crontab — only needed to clear pre-2.70 root cron entries")
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

    # The carve-outs are SKIPPED, never handed over and undone.
    #
    # This used to be one blanket `chown -R "${SVC_USER}" "${APP_DIR}"` with the
    # re-lock below undoing it for deploy/ and .git afterwards. That is not
    # equivalent, and the difference is a route to root: chown changes metadata,
    # not content, so every byte the service account managed to write while it
    # owned deploy/perform-update.sh SURVIVED the re-lock — leaving a root-owned
    # file holding app-chosen content, which root then executes via the helper
    # unit. Nor was the window a knife-edge: `chown -R` walks in readdir order
    # and reaches deploy/ long before node_modules, so the scripts stayed
    # service-user-owned for the rest of a tens-of-thousands-of-files traversal,
    # and the app can summon an update on demand by writing .update-request.
    #
    # Iterating the top-level entries and skipping the two carve-outs keeps them
    # root-owned for the whole call. It is also immune to a trailing slash on
    # APP_DIR, which a `find -path` prune would not be.
    local entry
    for entry in "${APP_DIR}"/* "${APP_DIR}"/.[!.]* "${APP_DIR}"/..?*; do
        # An unmatched glob expands to itself; -e/-L filters those out.
        [ -e "${entry}" ] || [ -L "${entry}" ] || continue
        case "${entry##*/}" in
            # Files root executes or restores from — never service-user-owned,
            # at any instant. deploy/ and .git carry the code root runs;
            # .update-backup is the rollback copy root restores from on a failed
            # update. Re-asserted below.
            deploy|.git|.update-backup) continue ;;
            # Files root writes but the app also reaches through the group. The
            # sweep must not hand them over even transiently: while the service
            # account owns one of these in the sticky APP_DIR it can rename it
            # aside and plant a symlink, and the .env block / ensure_state_file
            # that run after the sweep would then follow that link (chown/chmod
            # a target of the attacker's choosing). Their correct ownership is
            # set by those two blocks; skipping them here just denies the window.
            .env|.update-status|.update-log|.auto-update-last-run) continue ;;
        esac
        # -h: the service account may create its own top-level entries here, so
        # a name may be a symlink it planted; retag the link, never its target.
        # This is belt-and-braces, not load-bearing: chown -R implies -P, and a
        # symlink given as an argument to chown -R is retagged (not followed)
        # even without -h (measured). The place a bare chown *does* follow is
        # the non-recursive .env block below — which is why that one is guarded.
        chown -Rh "${SVC_USER}:${SVC_GROUP}" -- "${entry}"
    done

    # Re-assert the carve-outs. Nothing above touches them any more, so on a
    # healthy install this is a no-op; it still matters as the migration path
    # for a tree whose deploy/, .git or .update-backup was left owned by the
    # service account, and as the re-lock for files git — running as root — has
    # just created. .update-backup is normally created root-owned by
    # perform-update.sh at the start of every update, so this is its safety net
    # rather than its primary owner; go-w leaves it readable so the rollback
    # path can still read the saved .next.
    local locked
    for locked in deploy .git .update-backup; do
        # A symlink here is never legitimate, and `chmod -R` follows a symlink
        # given as an argument, so leave it alone rather than chmod'ing through
        # it. (chmod ignores symlinks it meets during the traversal itself.)
        if [ -e "${APP_DIR}/${locked}" ] && [ ! -L "${APP_DIR}/${locked}" ]; then
            chown -Rh root:root -- "${APP_DIR}/${locked}"
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
    #
    # Hardened like ensure_state_file, as defence in depth behind the sweep
    # carve-out above: a bare `chown`/`chmod` (no -R, no -h) FOLLOWS a symlink
    # (measured), so if a symlink were ever present here root would retag/relax
    # a target of the attacker's choosing. The carve-out means .env is never
    # handed to the service account, so it cannot rename one in — but drop a
    # symlink rather than follow it in any case, and guard the chmod (which has
    # no -h and always follows) behind [ ! -L ].
    #
    # Only a symlink the SERVICE ACCOUNT owns is removed. An attacker-planted one
    # is owned by that account by construction — it is the only identity that
    # could have created it — so that is the whole of the migration job this
    # removal still has (clearing one left over from before the carve-out
    # existed). A root-owned symlink, by contrast, is an operator pointing .env
    # at a config-managed secrets directory: deleting it takes DATABASE_URL and
    # JWT_SECRET away from both the app and the updater, and re-creating it is
    # futile because the next run would delete it again. The [ ! -L ] guard below
    # already makes leaving it alone safe, so leave it alone.
    if [ -L "${APP_DIR}/.env" ] &&
       [ "$(stat -c '%U' "${APP_DIR}/.env" 2>/dev/null || echo root)" = "${SVC_USER}" ]; then
        rm -f "${APP_DIR}/.env"
    fi
    if [ -e "${APP_DIR}/.env" ] && [ ! -L "${APP_DIR}/.env" ]; then
        chown -h "root:${SVC_GROUP}" "${APP_DIR}/.env"
        chmod 0660 "${APP_DIR}/.env"
    fi

    # Must come last: the sweep above would otherwise leave these owned by the
    # service user, which is exactly what breaks root's writes to them.
    # .auto-update-last-run is written by root from auto-update.sh, so it gets
    # the same treatment: pre-created root-owned, never adopted from a symlink
    # the service account could have planted first.
    ensure_state_file "${APP_DIR}/.update-status" "${APP_DIR}/.update-log" \
        "${APP_DIR}/.auto-update-last-run"
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
        # Never adopt a symlink: these files live in directories the service
        # account can create entries in, and root writes to them afterwards.
        if [ -L "${f}" ]; then
            rm -f "${f}"
        fi
        # `set -C` turns the redirection into an O_CREAT|O_EXCL open, which
        # fails outright rather than following a symlink planted between the
        # check above and this line — they are separate path lookups, and a
        # plain `: > "${f}"` would truncate whatever the link pointed at.
        if [ ! -e "${f}" ]; then
            ( set -C; : > "${f}" ) 2>/dev/null || true
        fi
        # stat(1) does not dereference, so this reports the link, not its
        # target. Skipping the two calls below when the file is already exactly
        # right — which it is on every call after the first — means the steady
        # state performs no path-following write here at all.
        if [ "$(stat -c '%U:%G %a' "${f}" 2>/dev/null)" != "root:${SVC_GROUP} 664" ]; then
            # -h: if a symlink did win the race above, retag the link rather
            # than chowning the file it points at.
            chown -h "root:${SVC_GROUP}" "${f}" 2>/dev/null || true
            # chmod has no -h and always follows, so only apply it once this is
            # known not to be a link.
            if [ ! -L "${f}" ]; then
                chmod 0664 "${f}" 2>/dev/null || true
            fi
        fi
    done
}

ensure_log_dir() {
    # Root-owned directory, group-readable/traversable by the service account,
    # with the individual log files pre-created root:group 0664 — the same split
    # as .update-status/.update-log and for the same reason. The service user
    # must not own the *directory*: root appends to updates.log and
    # update-agent.log, so owning the directory would let the unprivileged
    # account replace either with a symlink and have root append wherever it
    # pointed. Owning neither the directory nor the files, but holding group
    # write on the files, it can still write its own logs.
    # Sticky (1775), like APP_DIR: the service account can add its own files but
    # cannot unlink root's, so the pre-created logs below cannot be swapped out.
    install -d -o root -g "${SVC_GROUP}" -m 1775 "${LOG_DIR}" 2>/dev/null || {
        mkdir -p "${LOG_DIR}"
        chown "root:${SVC_GROUP}" "${LOG_DIR}" 2>/dev/null || true
        chmod 1775 "${LOG_DIR}" 2>/dev/null || true
    }
    ensure_state_file \
        "${LOG_DIR}/updates.log" \
        "${LOG_DIR}/update-agent.log" \
        "${LOG_DIR}/exports.log" \
        "${LOG_DIR}/backups.log" \
        "${LOG_DIR}/credential-check.log"
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
    if [ "$(id -u)" -ne 0 ]; then
        # Already unprivileged — nothing to drop.
        "$@"
        return $?
    fi

    # Fail closed. Running the command as root because the service account is
    # missing would silently void the entire privilege drop — including the
    # `npm install` this exists to keep away from root — and do so on precisely
    # the misconfigured host where that matters most. ensure_service_user runs
    # before any caller gets here, so reaching this is a real fault.
    if ! id -u "${SVC_USER}" >/dev/null 2>&1; then
        echo "ERROR: service account '${SVC_USER}' does not exist; refusing to run '$1' as root." >&2
        echo "       Run 'bash deploy/install.sh' as root to create it." >&2
        return 1
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
*/5 * * * * ${SVC_USER} bash ${APP_DIR}/deploy/auto-backup.sh ${APP_DIR}
* * * * * ${SVC_USER} bash ${APP_DIR}/deploy/auto-export.sh ${APP_DIR}
0 6 * * * ${SVC_USER} bash ${APP_DIR}/deploy/auto-credential-check.sh ${APP_DIR}
CRONEOF
    chmod 0644 /etc/cron.d/training-tracker

    # Pre-2.70 installs had the app (running as root) write these entries into
    # root's crontab. The cron.d file above now covers all of them, so leaving
    # them would double up — auto-export in particular would fire twice a
    # minute.
    #
    # auto-backup used to be excluded here, on the grounds that its schedule was
    # still app-managed. It no longer is: from v2.90 auto-backup.sh reads
    # .auto-backup.json and decides for itself, exactly like auto-update.sh, so
    # the stale root entry is now a genuine duplicate. Stripping it is only safe
    # because the replacement line is written above in this same function —
    # there is no window in which neither exists.
    command -v crontab >/dev/null 2>&1 || return 0
    local current
    current="$(crontab -l 2>/dev/null || true)"
    case "${current}" in
        *training-tracker-auto-update*|*training-tracker-auto-export*|*training-tracker-auto-backup*)
            echo "Removing superseded root crontab entries (now in /etc/cron.d)..."
            printf '%s\n' "${current}" \
                | grep -v 'training-tracker-auto-update' \
                | grep -v 'training-tracker-auto-export' \
                | grep -v 'training-tracker-auto-backup' \
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
        # Skip symlinks. training-tracker-update.service sets PrivateTmp=yes so
        # the app cannot plant one there, but update.sh runs outside that unit
        # (and the init.d fallback has no unit at all), and `[ -f ]` follows
        # links — which would copy the target's first 8 KB into a log the
        # service account can read.
        [ -L "${f}" ] && continue
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
