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

# Fixed, deliberately NOT `${VAR:-default}`.
#
# These three name the account the whole tree is handed to, the group that
# reaches the shared state files, and the directory root creates and writes logs
# in. Leaving them environment-overridable meant whoever invoked a privileged
# script chose all three — see the note in require_root on why that is not
# merely a stylistic point. Nothing in this project has ever set them from the
# environment, so pinning them changes no supported behaviour.
SVC_USER="training-tracker"
SVC_GROUP="training-tracker"
LOG_DIR="/var/log/training-tracker"

# APP_DIR is different, and stays overridable on purpose: every entry point
# assigns it from its own argv or from a literal BEFORE sourcing this file
# (`APP_DIR="${1:-/opt/training-tracker}"`), which ignores the environment, and
# update.sh/perform-update.sh re-enter this file in a fresh bash after the pull
# and pass APP_DIR through the environment to do it. So the environment can only
# supply it to a process that is already root and had no other source for it.
APP_DIR="${APP_DIR:-/opt/training-tracker}"
# shellcheck disable=SC2034  # consumed by auto-update.sh, which sources this file.
UPDATE_REQUEST_FILE="${APP_DIR}/.update-request"

# --- Configuration -----------------------------------------------------------

# Keys that root legitimately needs out of .env. Nothing outside this list is
# read, so adding a variable here is a deliberate act.
#
# Every key on this list names a value the unprivileged service account can
# choose (it writes .env), so parsing the file safely is only half the job — the
# values are looked at too, but only where doing something about one is an
# improvement:
#
#   GITHUB_TOKEN         checked_github_token, at its point of use in
#                        ensure_origin_remote, where a rejection is FATAL: it
#                        reshapes the URL root pulls from.
#   NODE_EXTRA_CA_CERTS  checked_ca_bundle, via check_env_values, where a
#                        rejection DROPS the value: it decides which certificate
#                        authority root's Node believes.
#   npm_config_cache     checked_npm_cache, via check_env_values, WARN only.
#   DATABASE_URL         checked_database_url, via check_env_values, WARN only —
#                        it reaches nothing that runs as root, and unsetting it
#                        would cost the update its database rollback.
#   UPDATE_CHANNEL       compared against a fixed set by its consumers.
#   CSP_MODE             compared against a fixed set by lib/csp.ts, which falls
#                        back to its default on anything it does not recognise.
#                        It is on this list so it survives an update: it is the
#                        operator's way back from a Content-Security-Policy that
#                        breaks a page, and a way back that a routine update
#                        silently discards is not one.
#   TT_BUILD_MIN_MB      read as a number by build_min_mb.
#
# The rule the last four follow: a check with no privilege boundary behind it
# reports, it does not act. Acting would make a validation failure worse than no
# validation at all.
ENV_ALLOWED_KEYS="DATABASE_URL GITHUB_TOKEN NODE_EXTRA_CA_CERTS UPDATE_CHANNEL CSP_MODE TT_BUILD_MIN_MB npm_config_cache"

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

    # Which keys this file actually supplied. Only those are value-checked: a
    # value already in root's environment was put there by whoever invoked the
    # script as root (the sudo re-exec forwards a closed list that includes none
    # of these), so it has a trusted source and silently dropping it would break
    # a legitimate one-off override such as
    # `NODE_EXTRA_CA_CERTS=/path/to/bundle bash update.sh`.
    local from_file=""

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
        # Trailing CR first, THEN one matching layer of surrounding quotes: a
        # .env that has been through a Windows editor ends the line KEY="v"<CR>,
        # and stripping the quotes first never matches, leaving the quote
        # characters embedded in the value. (That produced a path or a token
        # nothing could use, silently; the value checks below now reject it
        # loudly, so getting the order right matters more than it used to.)
        value="${value%$'\r'}"
        case "${value}" in
            \"*\") value="${value#\"}"; value="${value%\"}" ;;
            "'"*"'") value="${value#\'}"; value="${value%\'}" ;;
        esac

        # printf -v assigns; it does not evaluate the value.
        printf -v "${key}" '%s' "${value}"
        export "${key?}"
        from_file="${from_file} ${key}"
    done < "${env_file}"

    # Parsing the file safely is only half the job — see check_env_values.
    check_env_values "${from_file}"
}

# --- .env value checks -------------------------------------------------------
#
# checked_github_token above is the model for these. The parser that reads .env
# is sound — it assigns, it never evaluates — but a correct parser wrapped
# around a value that is then handed to a privileged program is not containment.
# .env is group-writable by the unprivileged service account by design, so every
# value on ENV_ALLOWED_KEYS is attacker-chosen after a compromise of the app,
# and each of these is checked before anything acts on it.
#
# Each returns 0 and echoes the accepted (whitespace-trimmed) value, or returns
# 1 and prints nothing. Callers drop a rejected value rather than aborting: the
# update must still be able to run, and each caller already handles the setting
# being absent.

# Trim leading and trailing whitespace. A trailing CR from a .env edited on
# Windows is not part of the value.
_trim_env_value() {
    local v="${1:-}"
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    printf '%s' "${v}"
}

# The extra CA bundle Node is told to trust.
#
# This is the one with real teeth. NODE_EXTRA_CA_CERTS is exported into the
# environment of every child the update scripts start, root-run ones included,
# and it does exactly what it says: it adds a certificate authority to the set
# Node will accept. A value naming a file the service account can write lets
# that account decide who root's Node believes — which is the whole of TLS.
#
# So the file must be a plain file the service account cannot change:
# root-owned, not world-writable, and not group-writable *to the service
# group*. A symlink is allowed (some distributions ship the bundle that way) but
# the link itself must be root-owned too, otherwise its target could simply be
# re-pointed.
#
# The group rule is deliberately about the service group rather than about the
# group-write bit as such. The threat is the application account rewriting the
# bundle; a `root:root 0664` file — which is what a configuration-management
# system tends to leave behind — is not that, and refusing it would cost an
# operator a working build behind an inspecting proxy for no security gain. The
# stock bundle written by update-ca-certificates (root:root 0644) passes either
# way, which is the case install.sh configures.
checked_ca_bundle() {
    local path meta mode owner group
    path="$(_trim_env_value "${1:-}")"
    [ -n "${path}" ] || return 1
    [ "${#path}" -le 4096 ] || return 1
    case "${path}" in
        /*) ;;
        *) return 1 ;;
    esac
    # No whitespace, quotes, or shell/URL punctuation: a certificate bundle path
    # has none of it, and a value that does is not one.
    case "${path}" in
        *[!A-Za-z0-9_./@:+-]*) return 1 ;;
    esac

    # If the name is a symlink, the link must be root's as well as the target.
    owner="$(stat -c '%U' "${path}" 2>/dev/null)" || return 1
    [ "${owner}" = "root" ] || return 1

    # -L: judge what Node will actually open.
    meta="$(stat -Lc '%F|%U|%a' "${path}" 2>/dev/null)" || return 1
    case "${meta}" in
        "regular file|root|"*|"regular empty file|root|"*) ;;
        *) return 1 ;;
    esac
    mode="${meta##*|}"
    # World-writable is never acceptable. The leading 0 makes bash read the mode
    # as octal.
    [ $(( 0${mode} & 0002 )) -eq 0 ] || return 1
    # Group-writable only matters when the group is the one the application runs
    # as — see the note above.
    if [ $(( 0${mode} & 0020 )) -ne 0 ]; then
        group="$(stat -Lc '%G' "${path}" 2>/dev/null)" || return 1
        [ "${group}" != "${SVC_GROUP}" ] || return 1
    fi

    printf '%s' "${path}"
}

# npm's cache directory.
#
# npm itself only ever runs as the service account here (run_as_service_user),
# so this crosses no privilege boundary today — but npm_config_cache is one of
# the npm_config_* levers, it is exported into root's environment alongside the
# rest, and "no boundary today" is not a property worth relying on. Accept an
# absolute path made of ordinary path characters with no parent-directory
# segment, and nothing else.
checked_npm_cache() {
    local path
    path="$(_trim_env_value "${1:-}")"
    [ -n "${path}" ] || return 1
    [ "${#path}" -le 4096 ] || return 1
    case "${path}" in
        /*) ;;
        *) return 1 ;;
    esac
    case "${path}" in
        *[!A-Za-z0-9_./@+-]*) return 1 ;;
        *'..'*) return 1 ;;
    esac
    printf '%s' "${path}"
}

# The database connection string.
#
# Be honest about what this check is for. DATABASE_URL reaches psql and pg_dump,
# and both of those are started through run_as_service_user — they run as the
# unprivileged account, which already holds the application's database
# credentials. Root's own shell only ever tests whether the value is empty and
# redirects the dump into a root-owned file. So there is no privilege boundary
# here to defend, and a check claiming otherwise would be theatre.
#
# So this reports and does not act: a value that fails is used anyway. Acting on
# it would be strictly harmful — an unset DATABASE_URL makes perform-update.sh
# skip the pre-update pg_dump, leaving the rollback nothing to restore from, and
# trading "this string looks odd" for "this update has no database safety net"
# is the wrong trade at any odds. What the check is worth is a line in the log
# when the value is not the shape every consumer expects. Deliberately loose
# besides: a real connection string is accepted whatever its password contains.
checked_database_url() {
    local url
    url="$(_trim_env_value "${1:-}")"
    [ -n "${url}" ] || return 1
    [ "${#url}" -le 4096 ] || return 1
    case "${url}" in
        postgres://*|postgresql://*) ;;
        *) return 1 ;;
    esac
    # Embedded newlines or tabs mean this is not one value.
    case "${url}" in
        *$'\n'*|*$'\r'*|*$'\t'*) return 1 ;;
    esac
    printf '%s' "${url}"
}

# Apply the checks above to the keys ${APP_DIR}/.env supplied, named in $1 as a
# space-separated list. Keys already in root's environment are NOT checked: the
# sudo re-exec forwards a closed list containing none of them, so such a value
# was set by whoever invoked the script as root, and dropping it would break a
# legitimate one-off override.
#
# Two different responses, and the difference is the whole point:
#
#   drop   only where the value genuinely crosses a privilege boundary, so
#          carrying on with it is worse than carrying on without it. That is
#          NODE_EXTRA_CA_CERTS alone — it decides which certificate authority
#          root's Node believes. Losing it breaks a build behind an inspecting
#          proxy in a way the operator will not connect to a .env line, so the
#          message has to say exactly what to fix.
#
#   warn   everywhere else. A validation failure must never leave the system
#          worse off than no validation at all, and unsetting DATABASE_URL does
#          exactly that: perform-update.sh then skips the pre-update pg_dump and
#          the rollback has nothing to restore from, trading a cosmetic
#          complaint for the loss of the update's database safety net. So the
#          odd-looking value is reported and then used.
#
# No message ever echoes the value: DATABASE_URL carries a password.
#
# GITHUB_TOKEN is not handled here: it is checked at the point of use, in
# ensure_origin_remote, where a rejection has to be fatal rather than ignorable.
check_env_values() {
    local from_file=" ${1:-} " checked

    if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ "${from_file#* NODE_EXTRA_CA_CERTS }" != "${from_file}" ]; then
        if checked="$(checked_ca_bundle "${NODE_EXTRA_CA_CERTS}")"; then
            export NODE_EXTRA_CA_CERTS="${checked}"
        else
            echo "ERROR: NODE_EXTRA_CA_CERTS in ${APP_DIR}/.env does not name a certificate file that only root can change." >&2
            echo "       It must be an absolute path to a root-owned regular file that is neither world-writable" >&2
            echo "       nor writable by the ${SVC_GROUP} group; otherwise the application account could choose" >&2
            echo "       which certificate authorities root trusts. Ignoring it for this run." >&2
            echo "       If this system is behind an SSL-inspecting proxy, the build below may now fail: point the" >&2
            echo "       setting at /etc/ssl/certs/ca-certificates.crt, or fix the ownership of the file it names." >&2
            unset NODE_EXTRA_CA_CERTS
        fi
    fi

    if [ -n "${npm_config_cache:-}" ] && [ "${from_file#* npm_config_cache }" != "${from_file}" ]; then
        checked_npm_cache "${npm_config_cache}" >/dev/null || \
            echo "WARNING: npm_config_cache in ${APP_DIR}/.env is not a plain absolute path. Using it anyway." >&2
    fi

    if [ -n "${DATABASE_URL:-}" ] && [ "${from_file#* DATABASE_URL }" != "${from_file}" ]; then
        checked_database_url "${DATABASE_URL}" >/dev/null || \
            echo "WARNING: DATABASE_URL in ${APP_DIR}/.env does not look like a postgres:// connection string. Using it anyway." >&2
    fi
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
# Environment variables a human invoker is documented as being able to set on
# the command line (see install.sh's site-configuration prompts and
# build_min_mb). These are the ONLY ones carried across the sudo re-exec below.
REEXEC_KEEP_ENV="APP_BASE_URL,TRUSTED_PROXIES,TT_BUILD_MIN_MB"

require_root() {
    [ "$(id -u)" -eq 0 ] && return 0

    if [ -f "$0" ] && command -v sudo >/dev/null 2>&1; then
        echo "Not running as root — re-executing under sudo..."
        # Forward a closed list, not the whole environment.
        #
        # This used to be `sudo -E`, which hands the *caller's entire
        # environment* to the root process. That is harmless when the caller is
        # a full sudoer — they could become root anyway — but it is not the only
        # way these scripts are run. A site that grants an operator the right to
        # run only the installer or the updater as root, and nothing else, is
        # relying on the privilege stopping at that command. It did not:
        # SVC_USER, SVC_GROUP, LOG_DIR and APP_DIR were all `${VAR:-default}`
        # below, so the caller's environment chose which account the tree is
        # chowned to, where the log directory is created and what goes into
        # /etc/cron.d. Measured: all three crossed intact into the root process.
        #
        # The long form keeps the command line byte-identical (`bash <script>`),
        # so any sudoers rule that matched the old invocation still matches this
        # one; older sudo builds without it simply carry nothing across, which
        # only means the operator is prompted for the site settings.
        #
        # It is only asked for when there is something to carry. Be honest about
        # what that is worth: on sudo 1.9 it is a NO-OP, because
        # --preserve-env=LIST simply ignores variables that are not set, so a
        # restricted rule without SETENV: already runs correctly when the
        # operator set nothing (measured). It is kept as defence in depth for a
        # sudo old enough to refuse the request on sight, or a policy using
        # env_check — neither of which could be tested here. Do not read it as
        # load-bearing, and do not remove it on the grounds that it is not.
        #
        # What the closed list DID fix is the row above it: replacing `-E` with
        # --preserve-env=<list> is what stops SVC_USER and friends crossing.
        #
        # When something IS set and the rule lacks SETENV:, sudo refuses and the
        # script stops. That is the right outcome: sudo's own message names the
        # variables, so the operator can add SETENV: or put the setting in .env,
        # rather than have their override silently dropped and a wrong value
        # baked into .env.
        #
        # LC_ALL=C because the probe matches sudo's help text.
        local keep="" var
        # Unquoted on purpose: REEXEC_KEEP_ENV is a literal defined in this
        # file and the comma-to-space substitution is what splits it.
        # An explicit `if` rather than `[ … ] && …` because install.sh runs
        # under `set -e`, where an AND-list whose test fails would abort it.
        for var in ${REEXEC_KEEP_ENV//,/ }; do
            if [ -n "${!var:-}" ]; then
                keep="${keep:+${keep},}${var}"
            fi
        done
        if [ -n "${keep}" ] && LC_ALL=C sudo --help 2>&1 | grep -q -- '--preserve-env=list'; then
            exec sudo "--preserve-env=${keep}" bash "$0" "$@"
        fi
        exec sudo bash "$0" "$@"
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
    # install.sh downloads the Node repository setup script to a private
    # temporary file before running it, rather than piping it into a shell.
    command -v mktemp  >/dev/null 2>&1 || missing+=("mktemp      (coreutils)")

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
    #
    # Skip both calls when .env is already exactly right — which it is on every
    # run after the first. chmod has no -h and always resolves the name in a
    # second path lookup, so the less often it runs on a name at all, the less
    # there is to race; in the steady state this block now performs no
    # path-following write whatsoever. (stat -c does not dereference, so a
    # symlink is reported as one rather than as its target.)
    case "$(stat -c '%F|%U:%G|%a' "${APP_DIR}/.env" 2>/dev/null || echo missing)" in
        "regular file|root:${SVC_GROUP}|660"|"regular empty file|root:${SVC_GROUP}|660")
            : # already correct
            ;;
        *)
            if [ -e "${APP_DIR}/.env" ] && [ ! -L "${APP_DIR}/.env" ]; then
                chown -h "root:${SVC_GROUP}" "${APP_DIR}/.env"
                chmod 0660 "${APP_DIR}/.env"
            fi
            ;;
    esac

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
# Set <path>'s mode to <octal mode> without ever following a symlink, and
# without needing write permission on the containing directory.
#
# The counterpart to read_file_nofollow, and it exists because the two obvious
# ways to fix a mode each give up one property that matters here:
#
#   chmod on a NAME            follows the final component in a lookup that is
#                              not the one the preceding check made, so a
#                              rename can land in between;
#   delete and re-create       is race-free, but unlinking needs write
#                              permission on the PARENT — which root does not
#                              have on an unprivileged LXC when the directory
#                              belongs to the service account, because root
#                              there has no effective CAP_DAC_OVERRIDE. That is
#                              precisely the tree this function is called on, so
#                              it must not depend on it.
#
# Opening with O_NOFOLLOW and then acting on the DESCRIPTOR gives both at once:
# a symlink at the name is refused by the open itself, and fchmod changes the
# inode that descriptor already refers to, so there is nothing left to race and
# nothing to unlink. O_NONBLOCK keeps a FIFO at the name from stalling the open
# (fstat then rejects it).
#
# The link count is the price of that, and it has to be paid here. Acting on the
# inode means a HARDLINK is followed where deleting the name would not have
# been: the same inode under another name is the same inode. So an entry with
# more than one link is refused outright. A state file legitimately has exactly
# one, so this costs nothing — and it is checked on the descriptor rather than
# on the name, which is what makes it a guard rather than another race. (The
# caller checks the link count as well, from its own lstat, so the replace path
# is chosen for a hardlinked name before this is ever reached; this is the half
# that closes the gap between that lstat and this open.)
#
# Returns 1, having changed nothing, when the path is not a plain file, has more
# than one link, cannot be opened, the fchmod is refused, or node is
# unavailable. Note that the open needs read permission, so a file with no owner
# read bit cannot be repaired this way when root also lacks CAP_DAC_READ_SEARCH;
# nothing in this system creates one, and the caller warns rather than guessing.
set_file_mode_nofollow() {
    local path="${1:-}" mode="${2:-}"
    [ -n "${path}" ] && [ -n "${mode}" ] || return 1
    command -v node >/dev/null 2>&1 || return 1

    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const mode = parseInt(process.argv[2], 8);
      let fd = -1;
      try {
        if (!Number.isFinite(mode)) process.exit(1);
        fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1) { fs.closeSync(fd); process.exit(1); }
        if ((st.mode & 0o7777) !== mode) fs.fchmodSync(fd, mode);
        fs.closeSync(fd);
      } catch (e) {
        if (fd >= 0) { try { fs.closeSync(fd); } catch (_) {} }
        process.exit(1);
      }
    ' "${path}" "${mode}" 2>/dev/null
}

ensure_state_file() {
    local f attempt state ok
    for f in "$@"; do
        ok=0
        # Four passes: three that may act, and a final verify-only pass so a
        # repair that lands on the third is not reported as a failure.
        for attempt in 1 2 3 4; do
            # lstat, not stat: `stat -c` does not dereference, so a symlink
            # reports as "symbolic link" rather than as whatever it points at.
            # GNU stat spells a zero-length file "regular empty file", so both
            # spellings appear below. One call decides type, owner, group and
            # mode together, with nothing left to re-check on a second lookup.
            # The link count is part of the decision, not an afterthought:
            # repairing in place acts on the INODE, and a hardlink is the same
            # inode under another name. An entry with more than one link is
            # therefore not something to repair — it falls through to the
            # replace branch below, which unlinks only this name and leaves
            # whatever else points at that inode alone. (set_file_mode_nofollow
            # re-checks on its descriptor, which is what closes the gap between
            # this lstat and its open.)
            state="$(stat -c '%F|%U:%G|%a|%h' "${f}" 2>/dev/null || echo 'missing')"

            case "${state}" in
                "regular file|root:${SVC_GROUP}|664|1"|"regular empty file|root:${SVC_GROUP}|664|1")
                    ok=1
                    break
                    ;;
            esac
            [ "${attempt}" -lt 4 ] || break

            case "${state}" in
                "regular file|"*"|1"|"regular empty file|"*"|1")
                    # A plain file. Repair it IN PLACE — never replace it.
                    #
                    # Both halves avoid the trap that motivated this rewrite
                    # without falling into the one that replacing it created:
                    # `chown -h` never resolves a symlink, and the mode is set
                    # through an open descriptor rather than through the name.
                    # Neither needs write permission on the containing
                    # directory, so this still repairs the file where root has
                    # no CAP_DAC_OVERRIDE and the directory belongs to the
                    # service account — the state a pre-2.70 tree is in when
                    # update-agent.sh calls this before the ownership repair
                    # runs. Replacing the file there fails outright and leaves
                    # it broken, which is the outage described at the top of
                    # this comment.
                    #
                    # Repairing rather than replacing also keeps the file's
                    # contents, so an existing update log survives.
                    case "${state}" in
                        *"|root:${SVC_GROUP}|"*) ;;
                        *) chown -h "root:${SVC_GROUP}" -- "${f}" 2>/dev/null || true ;;
                    esac
                    case "${state}" in
                        *'|664|1') ;;
                        *)
                            if ! set_file_mode_nofollow "${f}" 0664; then
                                # Only when there is no safe mechanism at all:
                                # a host with no node (the window during a fresh
                                # install, before step 2 has run) also has no
                                # application running that could plant a link,
                                # and leaving the file unrepairable is the worse
                                # outcome. When node IS present its refusal is
                                # trusted — it means the entry is not a plain
                                # file, and chmod'ing the name would be exactly
                                # the mistake being avoided.
                                if ! command -v node >/dev/null 2>&1 && [ ! -L "${f}" ]; then
                                    chmod 0664 -- "${f}" 2>/dev/null || true
                                fi
                            fi
                            ;;
                    esac
                    continue
                    ;;
            esac

            # Not a plain single-linked file — a symlink, a FIFO, a directory,
            # a socket, a hardlink to something else — or missing. There is no
            # inode here worth keeping and no safe way to adjust one, so replace
            # it: `rm -f`, then create with `set -C`
            # (an O_CREAT|O_EXCL open, which fails outright rather than
            # following a link planted since the rm) under `umask 0113`, so the
            # file is born 0664 and needs no chmod at all.
            rm -f -- "${f}" 2>/dev/null || true
            ( umask 0113; set -C; : > "${f}" ) 2>/dev/null || continue
            chown -h "root:${SVC_GROUP}" -- "${f}" 2>/dev/null || true
        done

        if [ "${ok}" -ne 1 ]; then
            echo "WARNING: could not establish ${f} as root:${SVC_GROUP} 0664 — update progress may not be recorded." >&2
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

# Read at most <max> bytes of <path> and write them to stdout, without ever
# following a symlink and without ever blocking.
#
# This exists because no coreutils tool can open a file with O_NOFOLLOW: `head`,
# `cat` and `dd` all resolve the final component, so a `[ -L ]` test before them
# is a *separate* path lookup and therefore only a race, not a guard. Whenever
# root reads a file living in a directory the unprivileged service account can
# create entries in (/tmp above all), that race is the whole exposure: swap the
# name for a symlink between the check and the open and root reads — and, in the
# caller's case, copies into a log the account can read — a file of the
# attacker's choosing.
#
# Three flags do the work, and all three are load-bearing:
#   O_NOFOLLOW  the open itself refuses a symlink, so there is no window
#   O_NONBLOCK  opening a FIFO returns immediately instead of waiting forever
#               for a writer (O_NOFOLLOW does not help here: the account can
#               create a FIFO *at* the name rather than a link to one)
#   fstat       the size and file-type checks are made against the descriptor
#               that is actually being read, not against the path again
#
# Returns 1 (printing nothing) when the path is not a plain readable file, when
# it is larger than the cap, or when node is unavailable. Callers must treat
# that as "no content" rather than falling back to an unguarded read.
read_file_nofollow() {
    local path="${1:-}" max="${2:-8000}"
    [ -n "${path}" ] || return 1
    command -v node >/dev/null 2>&1 || return 1

    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const max = Number(process.argv[2]) || 0;
      let fd = -1;
      try {
        fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const st = fs.fstatSync(fd);
        if (!st.isFile()) { fs.closeSync(fd); process.exit(1); }
        const n = Math.min(st.size, max);
        if (n > 0) {
          const buf = Buffer.alloc(n);
          let off = 0;
          for (;;) {
            const r = fs.readSync(fd, buf, off, n - off, off);
            if (r <= 0 || off >= n) break;
            off += r;
          }
          fs.closeSync(fd);
          fd = -1;
          process.stdout.write(buf.subarray(0, off));
        } else {
          fs.closeSync(fd);
          fd = -1;
        }
      } catch (e) {
        if (fd >= 0) { try { fs.closeSync(fd); } catch (_) {} }
        process.exit(1);
      }
    ' "${path}" "${max}" 2>/dev/null
}

# Copy any Next.js panic dumps written since <epoch seconds> into <logfile>.
#
# A Turbopack panic writes its detail to /tmp/next-panic-<hash>.log and prints
# only the path, so the build output on its own says almost nothing. /tmp is
# cleared on reboot: unless the dump is copied somewhere durable at the moment it
# happens, the one artefact that explains the failure is gone before anyone looks.
#
# The destination is .update-log, which the service account reads — so this is a
# root read whose result is handed straight to the unprivileged side, and /tmp is
# world-writable. training-tracker-update.service sets PrivateTmp=yes, which
# gives the systemd path its own /tmp and closes this; update.sh run by hand and
# the init.d fallback have no such namespace. Hence read_file_nofollow above:
# the file type is decided by the descriptor being read, not by a preceding test
# on the name.
capture_panic_logs() {
    local since="$1" dest="$2" f content

    [ -n "${dest}" ] && [ -w "${dest}" ] || return 0
    [ -d /tmp ] || return 0

    while IFS= read -r f; do
        # No [ -L ]/[ -f ] pre-test: it would only re-introduce the check-then-
        # open gap this function exists to avoid, and read_file_nofollow already
        # refuses anything that is not a plain file.
        if content="$(read_file_nofollow "${f}" 8000)"; then
            {
                echo "--- begin ${f} ---"
                printf '%s\n' "${content}"
                echo "--- end ${f} ---"
            } >> "${dest}"
        else
            echo "--- skipped ${f}: not a plain readable file ---" >> "${dest}"
        fi
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
