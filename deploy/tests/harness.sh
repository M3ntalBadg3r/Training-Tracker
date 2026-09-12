#!/bin/bash
# Minimal assertion harness for the deploy/ fixture tests.
#
# There is no shell test framework in this project's dependency set and adding
# one would put the deploy layer's checks behind an npm install — the opposite
# of what these tests are for, since they exist to catch breakage in the scripts
# that run *before* and *around* the application. So: plain bash, no deps.
#
# The one rule that matters here is the one the suite exists to serve: a check
# that cannot run must FAIL, never pass quietly. Every precondition below aborts
# the run rather than skipping, because a green suite that silently tested
# nothing is worse than no suite at all.

TESTS_RUN=0
TESTS_FAILED=0
CURRENT_TEST=""

# Terminal colour only when stdout is a terminal, so CI logs stay plain.
if [ -t 1 ]; then
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
    C_RED=""; C_GREEN=""; C_DIM=""; C_OFF=""
fi

start_test() {
    CURRENT_TEST="$1"
    TESTS_RUN=$((TESTS_RUN + 1))
}

pass() {
    printf '  %sok%s   %s\n' "${C_GREEN}" "${C_OFF}" "${CURRENT_TEST}"
}

fail() {
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf '  %sFAIL%s %s\n' "${C_RED}" "${C_OFF}" "${CURRENT_TEST}"
    local line
    for line in "$@"; do
        printf '       %s%s%s\n' "${C_DIM}" "${line}" "${C_OFF}"
    done
}

# assert_eq <expected> <actual> [context...]
assert_eq() {
    local expected="$1" actual="$2"; shift 2
    if [ "${expected}" = "${actual}" ]; then
        pass
    else
        fail "expected: ${expected}" "actual:   ${actual}" "$@"
    fi
}

# assert_contains <haystack> <needle> [context...]
assert_contains() {
    local haystack="$1" needle="$2"; shift 2
    case "${haystack}" in
        *"${needle}"*) pass ;;
        *) fail "expected to contain: ${needle}" "actual: ${haystack}" "$@" ;;
    esac
}

# assert_not_contains <haystack> <needle> [context...]
assert_not_contains() {
    local haystack="$1" needle="$2"; shift 2
    case "${haystack}" in
        *"${needle}"*) fail "expected NOT to contain: ${needle}" "actual: ${haystack}" "$@" ;;
        *) pass ;;
    esac
}

# The identity a state file must end up with, as one comparable string.
# stat -c does not dereference, so a symlink reports as a symlink rather than as
# whatever it points at — which is the whole point when testing a function whose
# job is to refuse them.
state_of() {
    stat -c '%F|%U:%G|%a|%h' "$1" 2>/dev/null || echo 'missing'
}

inode_of() {
    stat -c '%i' "$1" 2>/dev/null || echo 'missing'
}

# Abort the whole run. Used for preconditions: a missing precondition must never
# read as a pass.
die() {
    printf '%sPRECONDITION FAILED:%s %s\n' "${C_RED}" "${C_OFF}" "$1" >&2
    exit 2
}

finish_suite() {
    printf '\n%s: %d assertions, %d failed\n' "${1:-suite}" "${TESTS_RUN}" "${TESTS_FAILED}"
    # A suite that ran NO assertions is a failure, not a pass. Without this,
    # gutting a suite's body leaves it reporting "all suites passed" — the exact
    # green-check-that-ran-nothing this whole directory exists to rule out, and
    # the same reasoning as run.sh refusing to run as a non-root user.
    if [ "${TESTS_RUN}" -eq 0 ]; then
        printf '%sERROR%s %s ran no assertions at all — treating that as a failure.\n' \
            "${C_RED}" "${C_OFF}" "${1:-suite}" >&2
        return 1
    fi
    [ "${TESTS_FAILED}" -eq 0 ]
}
