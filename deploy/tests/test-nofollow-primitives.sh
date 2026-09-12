#!/bin/bash
# read_file_nofollow and set_file_mode_nofollow — the two descriptor-based
# primitives ensure_state_file and capture_panic_logs are built on.
#
# common.sh calls them counterparts, and they fail for the same reasons, so they
# are tested together. Both exist because a check on a NAME is a different path
# lookup from the operation that follows it: `[ -L f ] && head f` is two
# lookups, and the gap between them is the bug. The property to pin is that the
# type, size and link count are all decided on the DESCRIPTOR — which is
# observable from outside only as "a symlink/FIFO/hardlink at the name is
# refused, and nothing it points at is touched".
#
# See CLAUDE.md, "Root never *interprets* anything the service user can write".

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/tests/harness.sh
source "${HERE}/harness.sh"

export APP_DIR="${TEST_APP_DIR:?TEST_APP_DIR must be set by run.sh}"
# shellcheck source=deploy/lib/common.sh
source "${HERE}/../lib/common.sh"
SVC_USER="${TEST_SVC_USER:?}"
SVC_GROUP="${TEST_SVC_GROUP:?}"

d="${APP_DIR}"
command -v node >/dev/null 2>&1 || die "node is required: both primitives return 1 without it, so every assertion below would pass for the wrong reason"

# ==== read_file_nofollow =====================================================

start_test "read_file_nofollow reads a plain file"
printf 'hello world\n' > "${d}/plain"
assert_eq "hello world" "$(read_file_nofollow "${d}/plain" 100)"

start_test "read_file_nofollow honours the size cap"
assert_eq "hello" "$(read_file_nofollow "${d}/plain" 5)" \
    "the cap is what bounds a root process reading a service-user-writable file"

start_test "read_file_nofollow returns empty for a zero cap"
assert_eq "|0" "$(read_file_nofollow "${d}/plain" 0)|$( read_file_nofollow "${d}/plain" 0 >/dev/null 2>&1; echo $? )"

start_test "read_file_nofollow reads an empty file without error"
: > "${d}/empty"
assert_eq "|0" "$(read_file_nofollow "${d}/empty" 100)|$( read_file_nofollow "${d}/empty" 100 >/dev/null 2>&1; echo $? )"

# The core refusal: a symlink at the name. On a stock kernel
# fs.protected_symlinks would also deny this in a sticky directory, so the test
# must not rely on the directory being sticky — it asserts the OPEN refuses it.
start_test "read_file_nofollow refuses a symlink"
ln -s "${d}/plain" "${d}/link"
read_file_nofollow "${d}/link" 100 >/dev/null 2>&1
assert_eq "1" "$?" "a symlink at the name was followed; root would read an attacker-chosen file"

start_test "read_file_nofollow refuses a symlink even to a file it could read"
assert_eq "" "$(read_file_nofollow "${d}/link" 100 2>/dev/null)" \
    "content came back through a symlink"

start_test "read_file_nofollow refuses a dangling symlink"
ln -s "${d}/no-such-file" "${d}/dangling"
read_file_nofollow "${d}/dangling" 100 >/dev/null 2>&1
assert_eq "1" "$?"

start_test "read_file_nofollow refuses a directory"
mkdir -p "${d}/adir"
read_file_nofollow "${d}/adir" 100 >/dev/null 2>&1
assert_eq "1" "$?"

start_test "read_file_nofollow refuses a missing path"
read_file_nofollow "${d}/not-here" 100 >/dev/null 2>&1
assert_eq "1" "$?"

# O_NONBLOCK, and the reason it is in the flags. An open of a FIFO for reading
# WITHOUT O_NONBLOCK blocks until a writer appears — for ever, in a root process
# running from cron. `timeout` distinguishes "refused" from "hung": a plain
# rc=1 could be either, but rc=124 is the timeout firing, which is the bug.
start_test "read_file_nofollow refuses a FIFO without blocking"
mkfifo "${d}/afifo"
timeout 10 bash -c 'set -u; export APP_DIR="$1"; source "$2"; read_file_nofollow "$3" 100' \
    _ "${APP_DIR}" "${HERE}/../lib/common.sh" "${d}/afifo" >/dev/null 2>&1
rc=$?
if [ "${rc}" = "124" ]; then
    fail "the open BLOCKED on a FIFO (timed out) — O_NONBLOCK is missing; a root cron job would hang for ever"
else
    assert_eq "1" "${rc}" "a FIFO at the name was not refused"
fi

start_test "read_file_nofollow requires a path argument"
read_file_nofollow "" 100 >/dev/null 2>&1
assert_eq "1" "$?"

# ==== set_file_mode_nofollow =================================================

start_test "set_file_mode_nofollow sets the mode of a plain file"
printf 'x' > "${d}/m"; chmod 0600 "${d}/m"
set_file_mode_nofollow "${d}/m" 0664
assert_eq "0|664" "$?|$(stat -c '%a' "${d}/m")"

start_test "set_file_mode_nofollow is a no-op when the mode already matches"
before="$(inode_of "${d}/m")"
set_file_mode_nofollow "${d}/m" 0664
assert_eq "0|664|${before}" "$?|$(stat -c '%a' "${d}/m")|$(inode_of "${d}/m")"

start_test "set_file_mode_nofollow preserves file content"
assert_eq "x" "$(cat "${d}/m")"

# The attack: a symlink at the name, so root's chmod relaxes a file of the
# attacker's choosing. Two assertions — the refusal, and the target being
# untouched — because only the second would catch a "fix" that refused after
# already acting.
start_test "set_file_mode_nofollow refuses a symlink"
printf 'y' > "${d}/target"; chmod 0600 "${d}/target"; chown root:root "${d}/target"
ln -s "${d}/target" "${d}/mlink"
set_file_mode_nofollow "${d}/mlink" 0664 >/dev/null 2>&1
assert_eq "1" "$?" "a symlink at the name was followed"

start_test "set_file_mode_nofollow leaves the symlink's target mode unchanged"
assert_eq "600" "$(stat -c '%a' "${d}/target")" \
    "root relaxed the mode of a file a symlink pointed at"

# The hardlink refusal, which is the price of acting on a descriptor: the same
# inode under another name is the same inode, so nlink != 1 must be refused.
start_test "set_file_mode_nofollow refuses a hardlinked file (nlink != 1)"
printf 'z' > "${d}/h1"; chmod 0600 "${d}/h1"
ln "${d}/h1" "${d}/h2"
set_file_mode_nofollow "${d}/h2" 0664 >/dev/null 2>&1
assert_eq "1" "$?" "an inode with more than one link was modified through one of its names"

start_test "set_file_mode_nofollow leaves the other hardlinked name's mode unchanged"
assert_eq "600" "$(stat -c '%a' "${d}/h1")"

start_test "set_file_mode_nofollow refuses a FIFO without blocking"
mkfifo "${d}/mfifo"
timeout 10 bash -c 'set -u; export APP_DIR="$1"; source "$2"; set_file_mode_nofollow "$3" 0664' \
    _ "${APP_DIR}" "${HERE}/../lib/common.sh" "${d}/mfifo" >/dev/null 2>&1
rc=$?
if [ "${rc}" = "124" ]; then
    fail "the open BLOCKED on a FIFO (timed out) — O_NONBLOCK is missing"
else
    assert_eq "1" "${rc}"
fi

start_test "set_file_mode_nofollow refuses a directory"
set_file_mode_nofollow "${d}/adir" 0664 >/dev/null 2>&1
assert_eq "1" "$?"

start_test "set_file_mode_nofollow refuses a missing path"
set_file_mode_nofollow "${d}/not-here" 0664 >/dev/null 2>&1
assert_eq "1" "$?"

start_test "set_file_mode_nofollow requires both arguments"
set_file_mode_nofollow "${d}/m" "" >/dev/null 2>&1
rc1=$?
set_file_mode_nofollow "" 0664 >/dev/null 2>&1
assert_eq "1|1" "${rc1}|$?"

start_test "set_file_mode_nofollow rejects a non-octal mode without changing anything"
chmod 0600 "${d}/m"
set_file_mode_nofollow "${d}/m" "notamode" >/dev/null 2>&1
assert_eq "1|600" "$?|$(stat -c '%a' "${d}/m")"

finish_suite "nofollow primitives"
