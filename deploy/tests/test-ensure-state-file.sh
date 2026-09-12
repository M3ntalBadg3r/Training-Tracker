#!/bin/bash
# ensure_state_file — the three-way decision, and the ownership invariant it
# establishes.
#
# Why this is worth a fixture: the function is the only thing standing between
# "root can record update progress" and the 2.70/2.71 outage where every log()
# and write_status() failed silently on an unprivileged LXC. Its correctness is
# not visible from reading a diff — it turns on which of three branches a given
# inode takes, and two of those branches exist for security reasons (a symlink
# or a hardlink the service account planted must be REPLACED, never adopted and
# repaired, because repairing acts on the inode).
#
# The matrix below is the input space that decision covers. See CLAUDE.md,
# "Root cannot be assumed able to write files it does not own".

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/tests/harness.sh
source "${HERE}/harness.sh"

# APP_DIR must be set before common.sh is sourced: it reads it at source time.
export APP_DIR="${TEST_APP_DIR:?TEST_APP_DIR must be set by run.sh}"
# shellcheck source=deploy/lib/common.sh
source "${HERE}/../lib/common.sh"

# SVC_USER/SVC_GROUP are fixed literals in common.sh (deliberately — see
# CLAUDE.md). The functions read them at call time, so pointing them at the
# throwaway account run.sh created is exactly equivalent to running against the
# real one, without requiring a `training-tracker` account on the test host.
SVC_USER="${TEST_SVC_USER:?}"
SVC_GROUP="${TEST_SVC_GROUP:?}"

WANT="root:${SVC_GROUP}|664|1"

# The state a state file must be in. Both spellings of "plain file" are accepted
# because GNU stat calls a zero-length file a "regular empty file" — a
# distinction that is invisible until a test compares the string.
assert_is_state_file() {
    local f="$1" ctx="${2:-}" got
    got="$(state_of "${f}")"
    case "${got}" in
        "regular file|${WANT}"|"regular empty file|${WANT}") pass ;;
        *) fail "expected: regular file|${WANT}" "actual:   ${got}" "${ctx}" ;;
    esac
}

d="${APP_DIR}"

# --- absent ------------------------------------------------------------------
start_test "absent path is created root:group 0664"
f="${d}/absent"
ensure_state_file "${f}" 2>/dev/null
assert_is_state_file "${f}"

# --- already correct: must do nothing ----------------------------------------
# "Nothing" is checked by inode identity, not by the mode: a replace would also
# leave the mode right, and that is precisely the mistake this branch avoids.
start_test "already-correct file is left alone (same inode, not replaced)"
f="${d}/correct"
printf 'existing log line\n' > "${f}"; chown "root:${SVC_GROUP}" "${f}"; chmod 0664 "${f}"
before="$(inode_of "${f}")"
ensure_state_file "${f}" 2>/dev/null
assert_eq "${before}" "$(inode_of "${f}")" "an already-correct file was replaced instead of left alone"

start_test "already-correct file produces no warning"
warn_out="$( { ensure_state_file "${f}" >/dev/null; } 2>&1 )"
assert_eq "" "${warn_out}" "a healthy file emitted a warning"

# --- plain file, wrong mode: repair IN PLACE ---------------------------------
start_test "wrong mode is repaired to 0664"
f="${d}/wrongmode"
printf 'KEEPME\n' > "${f}"; chown "root:${SVC_GROUP}" "${f}"; chmod 0600 "${f}"
before="$(inode_of "${f}")"
ensure_state_file "${f}" 2>/dev/null
assert_is_state_file "${f}"

start_test "wrong-mode repair keeps the same inode (repaired, not replaced)"
assert_eq "${before}" "$(inode_of "${f}")" "the file was replaced; an existing update log would have been lost"

start_test "wrong-mode repair preserves content"
assert_eq "KEEPME" "$(cat "${f}")" "content was lost during an in-place repair"

# --- plain file, wrong owner: repair IN PLACE --------------------------------
start_test "wrong owner is repaired to root:group"
f="${d}/wrongowner"
printf 'KEEPME\n' > "${f}"; chown "${SVC_USER}:${SVC_GROUP}" "${f}"; chmod 0664 "${f}"
before="$(inode_of "${f}")"
ensure_state_file "${f}" 2>/dev/null
assert_is_state_file "${f}"

start_test "wrong-owner repair keeps the same inode and content"
assert_eq "${before}|KEEPME" "$(inode_of "${f}")|$(cat "${f}")" "a plain file with the wrong owner was replaced"

# --- symlink: REPLACE, and do not touch the target ---------------------------
# The attack this closes: the service account plants a symlink at the state
# file's name, and root's chown/chmod retags a target of its choosing.
start_test "symlink is replaced by a real file"
f="${d}/symlink"
target="${d}/symlink-target"
printf 'TARGET CONTENT\n' > "${target}"; chmod 0644 "${target}"; chown root:root "${target}"
ln -s "${target}" "${f}"
ensure_state_file "${f}" 2>/dev/null
assert_is_state_file "${f}"

start_test "symlink target is left completely untouched"
assert_eq "TARGET CONTENT|root:root|644" \
    "$(cat "${target}")|$(stat -c '%U:%G|%a' "${target}")" \
    "root followed a planted symlink and modified its target"

start_test "dangling symlink is replaced by a real file"
f="${d}/dangling"
ln -s "${d}/does-not-exist" "${f}"
ensure_state_file "${f}" 2>/dev/null
assert_is_state_file "${f}"

# --- FIFO: REPLACE (and must not block) --------------------------------------
# A FIFO at the name is the other half of the same idea: an open without
# O_NONBLOCK would hang a root process for ever waiting for a writer.
start_test "FIFO is replaced by a real file (and does not block)"
f="${d}/fifo"
mkfifo "${f}"
ensure_state_file "${f}" 2>/dev/null
assert_is_state_file "${f}"

# --- socket: REPLACE ---------------------------------------------------------
start_test "socket is replaced by a real file"
f="${d}/socket"
if ! python3 -c "
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(sys.argv[1])
" "${f}" 2>/dev/null; then
    die "could not create a unix socket for the socket fixture (python3 missing?)"
fi
[ -S "${f}" ] || die "socket fixture did not produce a socket"
ensure_state_file "${f}" 2>/dev/null
assert_is_state_file "${f}"

# --- directory: must NOT be recursively removed ------------------------------
# The replace branch is `rm -f`, not `rm -rf`, so a directory cannot be
# established and the function says so. That refusal is the safe outcome and is
# worth pinning: a future "fix" that reached for -rf would delete a tree.
start_test "directory is refused with a warning, not recursively deleted"
f="${d}/adirectory"
mkdir -p "${f}"; printf 'do not delete me\n' > "${f}/inside"
warn_out="$( { ensure_state_file "${f}" >/dev/null; } 2>&1 )"
assert_contains "${warn_out}" "could not establish" "a non-establishable path did not warn"

start_test "directory and its contents survive"
assert_eq "directory|do not delete me" \
    "$(stat -c '%F' "${f}")|$(cat "${f}/inside" 2>/dev/null)" \
    "ensure_state_file deleted a directory tree"

# --- hardlink (nlink > 1): REFUSE to repair, REPLACE instead -----------------
# The price of repairing through a descriptor is that a hardlink is the same
# inode under another name, so an in-place repair would reach through it. The
# link count is therefore part of the decision. This fixture is the only thing
# that would notice if `%h` were dropped from the stat format.
start_test "hardlinked file is replaced, not repaired"
f="${d}/hardlinked"
other="${d}/hardlink-other"
printf 'OTHER NAME CONTENT\n' > "${other}"; chown root:root "${other}"; chmod 0600 "${other}"
ln "${other}" "${f}"
ensure_state_file "${f}" 2>/dev/null
assert_is_state_file "${f}"

start_test "the other hardlinked name keeps its own content and mode"
assert_eq "OTHER NAME CONTENT|root:root|600|1" \
    "$(cat "${other}")|$(stat -c '%U:%G|%a|%h' "${other}")" \
    "the repair reached through a hardlink and modified the other name's inode"

# A hardlink whose owner and mode are ALREADY correct still has nlink=2, so it
# must not be waved through by the fast path.
start_test "hardlink with already-correct owner and mode is still replaced"
f="${d}/hardlinked-correct"
other="${d}/hardlink-other-correct"
printf 'SHARED\n' > "${other}"; ln "${other}" "${f}"
chown "root:${SVC_GROUP}" "${f}"; chmod 0664 "${f}"
ensure_state_file "${f}" 2>/dev/null
assert_is_state_file "${f}"

start_test "the correct-looking hardlink's other name is left intact"
assert_eq "SHARED|1" "$(cat "${other}")|$(stat -c '%h' "${f}")" \
    "a hardlinked name with a plausible owner/mode was adopted rather than replaced"

# --- idempotency -------------------------------------------------------------
# Convergence matters because this runs on every update, on every cron tick that
# repairs a tree, and inside ensure_ownership. A function that flapped would
# churn the files root and the app share.
start_test "repeated runs converge and stay silent"
f="${d}/idempotent"
printf 'log\n' > "${f}"; chown "${SVC_USER}:${SVC_GROUP}" "${f}"; chmod 0600 "${f}"
ensure_state_file "${f}" 2>/dev/null
first_inode="$(inode_of "${f}")"
run2="$(ensure_state_file "${f}" 2>&1 >/dev/null)"
run3="$(ensure_state_file "${f}" 2>&1 >/dev/null)"
assert_eq "|||${first_inode}" "${run2}|${run3}||$(inode_of "${f}")" \
    "repeated runs warned or replaced the file (state did not converge)"

# --- several paths in one call ----------------------------------------------
# It is variadic and every caller uses it that way (ensure_log_dir passes five).
start_test "handles several paths in one call"
ensure_state_file "${d}/multi1" "${d}/multi2" "${d}/multi3" 2>/dev/null
assert_eq "ok|ok|ok" \
    "$(for m in multi1 multi2 multi3; do
        case "$(state_of "${d}/${m}")" in
            "regular file|${WANT}"|"regular empty file|${WANT}") printf 'ok' ;;
            *) printf 'bad' ;;
        esac
        [ "${m}" = multi3 ] || printf '|'
    done)"

finish_suite "ensure_state_file"
