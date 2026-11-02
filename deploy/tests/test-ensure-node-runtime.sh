#!/bin/bash
# ensure_node_runtime — the step that upgrades the host's `nodejs` package when
# the running Node is below its line's security floor.
#
# It runs as root during every update, so the properties pinned here are about
# what it must NOT do as much as what it does:
#   - a Node at or above its floor touches apt not at all (no network, no lock);
#   - a Node that dpkg did not install, or an unsupported line, is reported and
#     left alone;
#   - it never crosses a major line, whatever apt offers;
#   - every failure path returns 0, because a Node upgrade that cannot happen
#     must never block or roll back an app update.
#
# apt-get, apt-cache, dpkg-query and `node -p` are stubbed on PATH, so no real
# package is ever touched. Everything else `node` does — loading
# deploy/lib/node-runtime.mjs — runs the real interpreter, which is what
# actually decides "below the floor".

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/tests/harness.sh
source "${HERE}/harness.sh"

export APP_DIR="${TEST_APP_DIR:?TEST_APP_DIR must be set by run.sh}"
# shellcheck source=deploy/lib/common.sh
source "${HERE}/../lib/common.sh"

REAL_NODE="$(command -v node)" || die "node is required"
STUBS="${APP_DIR}/stubs"
STATE="${APP_DIR}/state"
mkdir -p "${STUBS}" "${STATE}"

# `node -p 'process.versions.node'` answers from the state file, so an "upgrade"
# by the apt-get stub is visible to the re-check that follows it. Any other
# invocation is the real interpreter.
cat > "${STUBS}/node" <<EOF
#!/bin/bash
if [ "\$1" = "-p" ]; then cat "${STATE}/node-version"; exit 0; fi
exec "${REAL_NODE}" "\$@"
EOF

cat > "${STUBS}/apt-get" <<EOF
#!/bin/bash
echo "apt-get \$*" >> "${STATE}/calls"
case " \$* " in
    *" update "*) exit "\$(cat "${STATE}/update-rc" 2>/dev/null || echo 0)" ;;
    *" install "*)
        [ -f "${STATE}/install-fails" ] && exit 100
        cat "${STATE}/installs-to" > "${STATE}/node-version"
        exit 0 ;;
esac
exit 0
EOF

cat > "${STUBS}/apt-cache" <<EOF
#!/bin/bash
echo "apt-cache \$*" >> "${STATE}/calls"
printf 'nodejs:\n  Installed: x\n  Candidate: %s\n' "\$(cat "${STATE}/candidate")"
EOF

cat > "${STUBS}/dpkg-query" <<EOF
#!/bin/bash
owner="\$(cat "${STATE}/owner")"
[ -n "\${owner}" ] || exit 1
echo "\${owner}: /usr/bin/node"
EOF
chmod 755 "${STUBS}"/*

export PATH="${STUBS}:${PATH}"
hash -r

# setup <installed> <owner|''> <candidate deb version> <installs-to>
setup() {
    printf '%s' "$1" > "${STATE}/node-version"
    printf '%s' "$2" > "${STATE}/owner"
    printf '%s' "$3" > "${STATE}/candidate"
    printf '%s' "$4" > "${STATE}/installs-to"
    rm -f "${STATE}/calls" "${STATE}/install-fails" "${STATE}/update-rc"
}

calls() { cat "${STATE}/calls" 2>/dev/null || true; }

# Run the function, capturing output and its exit status together.
run() {
    OUT="$(ensure_node_runtime 2>&1)"
    RC=$?
}

# --- the floor module itself --------------------------------------------------

start_test "floor table: below, at and above the 22.x floor"
assert_eq "belowFloor 22.23.4|ok 22.23.4|ok 22.23.4" \
    "$(node_floor_status 22.22.0)|$(node_floor_status 22.23.4)|$(node_floor_status v22.24.0)"

start_test "floor table: an odd or unlisted line is unsupported, junk is unknown"
assert_eq "unsupported -|unsupported -|unknown -" \
    "$(node_floor_status 23.1.0)|$(node_floor_status 20.19.0)|$(node_floor_status banana)"

start_test "Debian versions reduce to their upstream part"
assert_eq "22.23.4|22.23.4|22.23.4" \
    "$(_node_upstream_version 22.23.4-1nodesource1)|$(_node_upstream_version 22.23.4-ns6.3.9)|$(_node_upstream_version 1:22.23.4-1)"

# --- ensure_node_runtime ------------------------------------------------------

start_test "at the floor: silent, and apt is never called"
setup 22.23.4 nodejs 22.23.4-1nodesource1 22.23.4
run
assert_eq "0||" "${RC}|${OUT}|$(calls)"

start_test "below the floor: upgrades nodejs within the line and says so"
setup 22.22.0 nodejs 22.23.4-1nodesource1 22.23.4
run
assert_contains "${OUT}" "upgraded 22.22.0 -> 22.23.4" "rc=${RC}"
start_test "below the floor: the install is --only-upgrade nodejs, never a general upgrade"
assert_contains "$(calls)" "--only-upgrade" "$(calls)"
start_test "below the floor: no 'apt-get upgrade' / dist-upgrade"
assert_not_contains "$(calls)" "apt-get upgrade" "$(calls)"

start_test "a Node dpkg did not install is left alone, apt untouched"
setup 22.22.0 "" 22.23.4-1nodesource1 22.23.4
run
assert_eq "0|" "${RC}|$(calls)" "${OUT}"
start_test "...and the operator is told to upgrade it by hand"
assert_contains "${OUT}" "by hand"

start_test "never crosses a major line, whatever apt offers"
setup 22.22.0 nodejs 24.22.1-1nodesource1 24.22.1
run
assert_eq "0|22.22.0" "${RC}|$(cat "${STATE}/node-version")" "${OUT}"
start_test "...and installs nothing"
assert_not_contains "$(calls)" "install" "$(calls)"

start_test "an unsupported line is reported, not upgraded"
setup 23.4.0 nodejs 23.11.0-1nodesource1 23.11.0
run
assert_eq "0|" "${RC}|$(calls)" "${OUT}"

start_test "a failed install returns 0 and warns (an app update must not fail on it)"
setup 22.22.0 nodejs 22.23.4-1nodesource1 22.23.4
touch "${STATE}/install-fails"
run
assert_eq "0|22.22.0" "${RC}|$(cat "${STATE}/node-version")" "${OUT}"
start_test "...with a warning naming the version it stayed on"
assert_contains "${OUT}" "still on 22.22.0"

start_test "an apt-get update error is warned about but the upgrade still proceeds"
setup 22.22.0 nodejs 22.23.4-1nodesource1 22.23.4
echo 100 > "${STATE}/update-rc"
run
assert_eq "0|22.23.4" "${RC}|$(cat "${STATE}/node-version")" "${OUT}"

start_test "a repository without the fix yet: upgrades what it can, says it is still below"
setup 22.22.0 nodejs 22.23.3-1nodesource1 22.23.3
run
assert_contains "${OUT}" "still below 22.23.4" "rc=${RC}"

start_test "no candidate at all returns 0 and installs nothing"
setup 22.22.0 nodejs "(none)" 22.22.0
run
assert_eq "0" "${RC}" "${OUT}"
start_test "...installs nothing"
assert_not_contains "$(calls)" "install" "$(calls)"

finish_suite "ensure_node_runtime"
