#!/bin/bash
# Fixture tests for the load-bearing helpers in deploy/lib/common.sh.
#
#   bash deploy/tests/run.sh          (as root)
#   npm run test:deploy
#
# WHY THESE NEED ROOT, AND WHY THEY ARE NOT SKIPPED WITHOUT IT
#
# Every property under test is about ownership and privilege: that root repairs
# a file in place rather than replacing it, that a symlink the unprivileged
# account planted is refused, that the sweep never hands deploy/ over. None of
# that is observable without being able to chown, so a non-root run can only
# either fail or pretend. It fails — a suite that silently tests nothing is
# worse than no suite, because it reports green.
#
# It creates a throwaway unprivileged account to stand in for the service user
# and removes it afterwards. SVC_USER/SVC_GROUP are fixed literals in common.sh
# (deliberately), but the functions read them at call time, so pointing them at
# the throwaway account is exactly equivalent to running against the real one —
# without requiring a `training-tracker` account on the test host, or leaving
# one behind on a developer's machine.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `stat -c %F` is localised by GNU coreutils and both common.sh and the fixtures
# compare against the English spellings ("regular file"). Pin the locale so a
# developer on a translated system sees the same result as CI.
export LC_ALL=C

if [ "$(id -u)" -ne 0 ]; then
    cat >&2 <<'MSG'
ERROR: deploy/tests/run.sh must run as root.

These fixtures assert ownership and privilege behaviour (chown, symlink
refusal, hardlink refusal, the root-owned carve-outs). Without root they could
only be skipped, and a skipped check that reports success is the failure mode
this suite exists to prevent.

Run as root:            bash deploy/tests/run.sh
On a machine with sudo: sudo bash deploy/tests/run.sh
MSG
    exit 2
fi

# Preconditions. Each one aborts rather than degrading the suite, for the same
# reason the root check does.
for tool in stat chown chmod mkfifo ln timeout node python3; do
    command -v "${tool}" >/dev/null 2>&1 || {
        echo "ERROR: '${tool}' is required by the fixtures but is not installed." >&2
        echo "       Aborting rather than skipping the checks that need it." >&2
        exit 2
    }
done

# Throwaway identities. The suffix keeps concurrent runs and a developer's own
# machine out of each other's way.
TEST_SVC_USER="ttest-svc-$$"
TEST_SVC_GROUP="ttest-grp-$$"
WORK="$(mktemp -d)"

cleanup() {
    # The tree is chowned to a uid that is about to stop existing, so remove it
    # before the account.
    rm -rf "${WORK}" 2>/dev/null || true
    userdel "${TEST_SVC_USER}" 2>/dev/null || true
    groupdel "${TEST_SVC_GROUP}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

groupadd "${TEST_SVC_GROUP}" 2>/dev/null || {
    echo "ERROR: could not create the throwaway group ${TEST_SVC_GROUP}." >&2; exit 2; }
useradd -M -N -g "${TEST_SVC_GROUP}" -s /usr/sbin/nologin "${TEST_SVC_USER}" 2>/dev/null || {
    echo "ERROR: could not create the throwaway user ${TEST_SVC_USER}." >&2; exit 2; }
id -u "${TEST_SVC_USER}" >/dev/null 2>&1 || {
    echo "ERROR: the throwaway account did not materialise; the fixtures would test nothing." >&2; exit 2; }

export TEST_SVC_USER TEST_SVC_GROUP

SUITES=(
    test-ensure-state-file.sh
    test-nofollow-primitives.sh
    test-load-env-allowlist.sh
    test-ensure-ownership.sh
)

failed=0
for suite in "${SUITES[@]}"; do
    [ -f "${HERE}/${suite}" ] || {
        echo "ERROR: suite ${suite} is listed but missing." >&2; exit 2; }
    echo
    echo "=== ${suite}"
    # Each suite gets its own APP_DIR: they create fixtures with colliding names
    # on purpose (a FIFO here, a symlink there), and sharing one directory would
    # make the order they run in part of the result.
    TEST_APP_DIR="${WORK}/${suite%.sh}"
    mkdir -p "${TEST_APP_DIR}"
    export TEST_APP_DIR
    if ! bash "${HERE}/${suite}"; then
        failed=$((failed + 1))
    fi
done

echo
if [ "${failed}" -ne 0 ]; then
    echo "DEPLOY FIXTURES: ${failed} suite(s) FAILED"
    exit 1
fi
echo "DEPLOY FIXTURES: all suites passed"
