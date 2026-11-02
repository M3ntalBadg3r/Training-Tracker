#!/bin/bash
# ensure_unattended_upgrades — install.sh's step that turns on the OS's own
# automatic security updates.
#
# It runs as root and changes host-wide configuration, so most of what is pinned
# here is about what it must NOT do:
#   - an explicit "0" in apt's configuration is a deliberate choice and is kept,
#     unless the operator said yes outright;
#   - APT::Periodic::Enable "0" (a container image's master switch) is never
#     overridden, whatever the answer;
#   - a "no" touches nothing at all;
#   - every failure path returns 0, because an install must not fail over this.
#
# apt-get, apt-config and systemctl are stubbed on PATH, and the function is
# pointed at a scratch configuration directory, so no real package or /etc file
# is touched. apt-config's stub "dumps" the base configuration, then the file
# the function writes, then an optional later override — the order apt reads
# them in — so "later wins" is exercised for real by the function's own reader.
#
# NOT covered: the systemd timer step (ensure_apt_timers). Whether it runs
# depends on /run/systemd/system on the machine running the suite, which the
# fixture cannot control; the stub only records calls.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/tests/harness.sh
source "${HERE}/harness.sh"

export APP_DIR="${TEST_APP_DIR:?TEST_APP_DIR must be set by run.sh}"
# shellcheck source=deploy/lib/common.sh
source "${HERE}/../lib/common.sh"

STUBS="${APP_DIR}/stubs"
STATE="${APP_DIR}/state"
CONF="${APP_DIR}/apt.conf.d"
mkdir -p "${STUBS}" "${STATE}" "${CONF}"

cat > "${STUBS}/apt-get" <<EOF
#!/bin/bash
echo "apt-get \$*" >> "${STATE}/calls"
[ -f "${STATE}/install-fails" ] && exit 100
touch "${STATE}/installed"
exit 0
EOF

# The resolved configuration, in apt's read order: base, then the file under
# test, then a later override. Output mimics \`apt-config dump\`.
cat > "${STUBS}/apt-config" <<EOF
#!/bin/bash
[ "\$1" = "dump" ] || exit 0
cat "${STATE}/base.conf" "${CONF}/20auto-upgrades" "${STATE}/late.conf" 2>/dev/null
EOF

cat > "${STUBS}/unattended-upgrade" <<'EOF'
#!/bin/bash
exit 0
EOF

cat > "${STUBS}/systemctl" <<EOF
#!/bin/bash
echo "systemctl \$*" >> "${STATE}/calls"
[ "\$1" = "is-enabled" ] && echo enabled
exit 0
EOF
chmod 755 "${STUBS}"/*

# `command -v unattended-upgrade` decides whether to install, so the function
# runs under a PATH this suite controls completely: the stubs, the package's
# stand-in when a case says it is installed, and a directory holding only the
# real tools the function and stubs need. Inheriting the host's PATH made "not
# installed" untestable on any machine that has the package — an earlier
# version of this suite passed or failed depending on the host.
BIN_PRESENT="${APP_DIR}/present"
MINBIN="${APP_DIR}/minbin"
mkdir -p "${BIN_PRESENT}" "${MINBIN}"
mv "${STUBS}/unattended-upgrade" "${BIN_PRESENT}/"
for tool in awk cat touch; do
    real="$(command -v "${tool}")" || die "${tool} is required"
    ln -s "${real}" "${MINBIN}/${tool}"
done
RUN_PATH=""

# setup <installed: yes|no> <base apt.conf content> [late override content]
setup() {
    rm -f "${STATE}"/* "${CONF}"/*
    if [ "$1" = "yes" ]; then
        RUN_PATH="${STUBS}:${BIN_PRESENT}:${MINBIN}"
    else
        RUN_PATH="${STUBS}:${MINBIN}"
    fi
    printf '%b' "$2" > "${STATE}/base.conf"
    [ $# -ge 3 ] && printf '%b' "$3" > "${STATE}/late.conf"
    true
}

calls() { cat "${STATE}/calls" 2>/dev/null || true; }
written() { cat "${CONF}/20auto-upgrades" 2>/dev/null || echo "<none>"; }

run() {
    OUT="$(PATH="${RUN_PATH}"; hash -r; ensure_unattended_upgrades "$1" "${CONF}" 2>&1)"
    RC=$?
}

# The reader, under the same controlled PATH.
config_value() { (PATH="${RUN_PATH}"; hash -r; apt_config_value "$1"); }

ON='APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n'

# --- the reader -------------------------------------------------------------

start_test "apt_config_value: last assignment wins, unset is empty"
setup yes 'APT::Periodic::Unattended-Upgrade "0";\nAPT::Periodic::Unattended-Upgrade "1";\n'
assert_eq "1|" "$(config_value APT::Periodic::Unattended-Upgrade)|$(config_value APT::Periodic::Enable)"

start_test "apt_config_value: keys match case-insensitively, as apt's do"
setup yes 'apt::periodic::unattended-upgrade "7";\n'
assert_eq "7" "$(config_value APT::Periodic::Unattended-Upgrade)"

# --- decisions --------------------------------------------------------------

start_test "unset configuration, default: turned on, standard file written"
setup yes ''
run default
assert_eq "0|$(printf "${ON}")" "${RC}|$(written)" "${OUT}"

start_test "already on: nothing is written"
setup yes "${ON}"
run default
assert_eq "0|<none>" "${RC}|$(written)" "${OUT}"
start_test "...and it says so"
assert_contains "${OUT}" "already on"

start_test "explicit \"0\", default answer: kept, nothing written"
setup yes 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "0";\n'
run default
assert_eq "0|<none>" "${RC}|$(written)" "${OUT}"

start_test "explicit \"0\" on the package-list refresh counts as switched off too"
setup yes 'APT::Periodic::Update-Package-Lists "0";\nAPT::Periodic::Unattended-Upgrade "1";\n'
run default
assert_eq "<none>" "$(written)" "${OUT}"

start_test "explicit \"0\", operator said yes: turned on"
setup yes 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "0";\n'
run yes
assert_contains "${OUT}" "turned on" "written: $(written)"

start_test "APT::Periodic::Enable \"0\" is never overridden, even on yes"
setup yes 'APT::Periodic::Enable "0";\n'
run yes
assert_eq "0|<none>" "${RC}|$(written)" "${OUT}"
start_test "...and the operator is told why"
assert_contains "${OUT}" "APT::Periodic::Enable"

start_test "declined: no apt call, nothing written"
setup no ''
run no
assert_eq "0||<none>" "${RC}|$(calls)|$(written)" "${OUT}"

start_test "package missing: installed, then turned on"
setup no ''
run default
assert_contains "$(calls)" "install -y -qq -o DPkg::Lock::Timeout=120 unattended-upgrades" "${OUT}"

start_test "package install fails: returns 0, writes nothing, warns"
setup no ''
touch "${STATE}/install-fails"
run default
assert_eq "0|<none>" "${RC}|$(written)" "${OUT}"
start_test "...with a warning"
assert_contains "${OUT}" "could not install"

start_test "a later file that still switches it off is reported, not hidden"
setup yes '' 'APT::Periodic::Unattended-Upgrade "0";\n'
run yes
assert_contains "${OUT}" "another apt configuration file still switches them off"

start_test "never touches 50unattended-upgrades (the origins stay the distribution's)"
setup yes ''
run yes
assert_eq "20auto-upgrades" "$(ls "${CONF}")"

finish_suite "ensure_unattended_upgrades"
