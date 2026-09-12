#!/bin/bash
# Mutation check: prove the fixtures can actually fail.
#
#   bash deploy/tests/mutate.sh     (as root)
#   npm run test:deploy:mutate
#
# A fixture that cannot detect a regression is decoration, and a suite of them
# is worse than decoration because it reports green. This script breaks
# deploy/lib/common.sh on purpose, one property at a time, in a COPY of the
# tree, and requires the named suite to go red. A mutation the suite does not
# notice is reported as a gap — that is the finding, not the pass.
#
# It never touches the real deploy/ directory: everything happens in a scratch
# copy that is removed on exit.
#
# ---------------------------------------------------------------------------
# WHY THERE IS A CONTROL RUN AND A CANARY
#
# The first version of this script had neither, and an independent review broke
# it in the most embarrassing way available: sabotage the account creation, feed
# it a COMMENT-ONLY edit that changes no behaviour, and it printed
#
#     caught        CONTROL: comment-only edit, breaks NOTHING
#     Every mutation was caught: the fixtures have teeth.
#
# and exited 0. The tool whose entire purpose is to prove tests can fail could
# not tell "the suite caught the mutation" from "the suite could not run at
# all". Every number it produced was worthless, including the 21/21 that was
# reported upstream as evidence.
#
# Two mechanisms close that, and both are load-bearing:
#
#   the CONTROL run  — every suite is run UNMUTATED in the same scratch
#                      environment first. If one fails there, the environment is
#                      broken and the whole run aborts, because from that point
#                      on every "caught" would be an environmental failure
#                      wearing a mutation's name.
#
#   the CANARY       — a mutation that deliberately changes NOTHING (a comment)
#                      must come back NOT DETECTED. If a no-op edit reads as
#                      "caught", the suite is failing for a reason unrelated to
#                      the thing being mutated, and every other result in the
#                      run is suspect.
#
# Setup failures are fatal rather than tolerated (`|| true` is gone, and the
# account is verified with `id -u` the way run.sh does), which is what made the
# original sabotage possible in the first place.
# ---------------------------------------------------------------------------
#
# To add a mutation, add a line to MUTATIONS below:
#     <suite-file>|<description>|<sed expression>
# The sed must actually change the file — a typo that matched nothing would
# otherwise "prove" the property was tested when nothing was broken at all, so
# a no-op edit is an error here, not a skip.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `stat -c %F` is localised by GNU coreutils and both common.sh and the fixtures
# compare against the English spellings ("regular file"). Pin the locale so a
# developer on a translated system sees the same result as CI.
export LC_ALL=C
DEPLOY_DIR="$(cd "${HERE}/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: mutate.sh must run as root (it drives the same fixtures as run.sh)." >&2
    exit 2
fi

if [ -t 1 ]; then
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_OFF=$'\033[0m'
else
    C_RED=""; C_GREEN=""; C_OFF=""
fi

SUITES=(
    test-ensure-state-file.sh
    test-nofollow-primitives.sh
    test-load-env-allowlist.sh
    test-ensure-ownership.sh
)

# One throwaway account for the whole run. Created once, verified, and removed
# on exit — NOT tolerated with `|| true`, because a run in which the account
# does not exist is a run whose every result is meaningless.
MUT_GRP="ttmut-grp-$$"
MUT_USR="ttmut-svc-$$"
SCRATCH=""

cleanup() {
    [ -n "${SCRATCH}" ] && rm -rf "${SCRATCH}" 2>/dev/null
    userdel "${MUT_USR}" 2>/dev/null || true
    groupdel "${MUT_GRP}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

groupadd "${MUT_GRP}" || { echo "ERROR: could not create group ${MUT_GRP}." >&2; exit 2; }
useradd -M -N -g "${MUT_GRP}" -s /usr/sbin/nologin "${MUT_USR}" || {
    echo "ERROR: could not create user ${MUT_USR}." >&2; exit 2; }
id -u "${MUT_USR}" >/dev/null 2>&1 || {
    echo "ERROR: ${MUT_USR} did not materialise; every result would be an environment failure." >&2
    exit 2; }

# Run one suite against a given deploy/ copy. Returns the suite's exit status.
run_suite() {
    local tree="$1" suite="$2" appdir
    appdir="$(mktemp -d)"
    TEST_APP_DIR="${appdir}" TEST_SVC_USER="${MUT_USR}" TEST_SVC_GROUP="${MUT_GRP}" \
        timeout 180 bash "${tree}/deploy/tests/${suite}" >/dev/null 2>&1
    local rc=$?
    rm -rf "${appdir}" 2>/dev/null
    return "${rc}"
}

# --- CONTROL -----------------------------------------------------------------
# Unmutated, in the same scratch environment every mutation will use. Anything
# other than a clean pass here means the environment is broken, and every
# subsequent "caught" would be that breakage rather than the mutation.
SCRATCH="$(mktemp -d)"
cp -a "${DEPLOY_DIR}" "${SCRATCH}/deploy"

echo "control: running every suite unmutated"
control_failed=0
for suite in "${SUITES[@]}"; do
    if run_suite "${SCRATCH}" "${suite}"; then
        printf '  %spass%s   %s\n' "${C_GREEN}" "${C_OFF}" "${suite}"
    else
        printf '  %sFAIL%s   %s\n' "${C_RED}" "${C_OFF}" "${suite}"
        control_failed=$((control_failed + 1))
    fi
done
if [ "${control_failed}" -ne 0 ]; then
    cat >&2 <<'MSG'

ERROR: the control run failed — the suites do not pass on an UNMUTATED tree in
this environment.

Every mutation result after this point would report "caught" for an
environmental failure rather than for the mutation, which is exactly the false
green this control exists to prevent. Aborting instead of producing numbers
that do not mean what they appear to mean.
MSG
    exit 2
fi
echo

# suite|description|sed expression
#
# The first entry is the CANARY and must stay first: a comment-only edit that
# changes no behaviour, which MUST come back NOT DETECTED.
MUTATIONS=(
"CANARY|test-ensure-state-file.sh|CANARY: comment-only edit, must NOT be detected|1a\\
# mutation canary: this comment changes no behaviour"
# --- ensure_state_file -------------------------------------------------------
"|test-ensure-state-file.sh|drop the link count from the stat that makes the decision|s/%F|%U:%G|%a|%h/%F|%U:%G|%a/"
"|test-ensure-state-file.sh|replace a plain file instead of repairing it in place|s|# A plain file. Repair it IN PLACE|rm -f -- \"\${f}\"; : > \"\${f}\"; # |"
"|test-ensure-state-file.sh|stop replacing non-plain files (leave a symlink or FIFO in place)|s|^            rm -f -- \"\${f}\" 2>/dev/null .*|            :|"
"|test-ensure-state-file.sh|establish the files 0644 instead of 0664|s/set_file_mode_nofollow \"\${f}\" 0664/set_file_mode_nofollow \"\${f}\" 0644/"
"|test-ensure-state-file.sh|give the state files to the service user instead of root|s/chown -h \"root:\${SVC_GROUP}\" -- \"\${f}\"/chown -h \"\${SVC_USER}:\${SVC_GROUP}\" -- \"\${f}\"/g"
# --- the nofollow primitives -------------------------------------------------
"|test-nofollow-primitives.sh|drop O_NOFOLLOW, so a planted symlink is followed|s/fs.constants.O_NOFOLLOW | //g"
"|test-nofollow-primitives.sh|drop O_NONBLOCK, so a FIFO at the name hangs a root process|s/ | fs.constants.O_NONBLOCK//g"
"|test-nofollow-primitives.sh|drop the nlink guard, so a hardlink is modified through|s/|| st.nlink !== 1//"
"|test-nofollow-primitives.sh|ignore the size cap when reading|s/Math.min(st.size, max)/st.size/"
"|test-nofollow-primitives.sh|stop checking that the descriptor is a plain file|s/if (!st.isFile()) { fs.closeSync(fd); process.exit(1); }//"
# --- load_env_allowlist ------------------------------------------------------
"|test-load-env-allowlist.sh|drop the allow-list, importing every key from .env|s/            \\*) continue ;;/            *) : ;;/"
"|test-load-env-allowlist.sh|evaluate values instead of assigning them|s|printf -v \"\${key}\" '%s' \"\${value}\"|eval \"\${key}=\${value}\"|"
"|test-load-env-allowlist.sh|stop exporting, so root's children never see the value|s/^        export \"\${key?}\"/        :/"
"|test-load-env-allowlist.sh|strip quotes before the trailing CR instead of after|s/value=\"\${value%\$'\\\\r'}\"//"
"|test-load-env-allowlist.sh|unset DATABASE_URL on rejection instead of warning|s|echo \"WARNING: DATABASE_URL in \${APP_DIR}/.env does not look like a postgres:// connection string. Using it anyway.\" >\&2|unset DATABASE_URL|"
"|test-load-env-allowlist.sh|keep an untrustworthy CA bundle instead of dropping it|s/^            unset NODE_EXTRA_CA_CERTS/            :/"
# The four checked_ca_bundle rules the original fixture never reached, because
# its fixture bundle was rejected by the owner check before any of them ran.
"|test-load-env-allowlist.sh|remove the service-group-writable rule from checked_ca_bundle|s/        \[ \"\${group}\" != \"\${SVC_GROUP}\" \] || return 1/        :/"
"|test-load-env-allowlist.sh|remove the world-writable rule from checked_ca_bundle|s/    \[ \$(( 0\${mode} \& 0002 )) -eq 0 \] || return 1/    :/"
# The symlink owner rule is the security-relevant one: without it a
# service-user-owned symlink pointing at a root bundle is accepted, and the
# account that owns the link can re-point it at will.
"|test-load-env-allowlist.sh|remove the symlink OWNER rule from checked_ca_bundle|s/^    \\[ \"\${owner}\" = \"root\" \\] || return 1$/    :/"
"|test-load-env-allowlist.sh|remove the absolute-path rule from checked_ca_bundle|0,/^        \\*) return 1 ;;$/ s|^        \\*) return 1 ;;$|        *) : ;;|"
"|test-load-env-allowlist.sh|remove the path-punctuation rule from checked_ca_bundle|s|        \*\[!A-Za-z0-9_./@:+-\]\*) return 1 ;;|        xxxnevermatchesxxx) return 1 ;;|"
# The direction that costs an inspecting-proxy install its CA bundle: a
# "tightening" that refuses the root:root 0664 file configuration management
# leaves behind. common.sh accepts it deliberately.
"|test-load-env-allowlist.sh|tighten checked_ca_bundle to reject ANY group-writable bundle|s/    if \[ \$(( 0\${mode} \& 0020 )) -ne 0 \]; then/    if [ \$(( 0\${mode} \& 0020 )) -ne 0 ]; then return 1; elif false; then/"
# --- ensure_ownership --------------------------------------------------------
"|test-ensure-ownership.sh|stop handing the application tree to the service user (the sweep's whole job)|s|^        chown -Rh \"\${SVC_USER}:\${SVC_GROUP}\" -- \"\${entry}\"|        :|"
"|test-ensure-ownership.sh|drop the missing-service-account guard|s/    id -u \"\${SVC_USER}\" >\/dev\/null 2>\&1 || return 0/    :/"
"|test-ensure-ownership.sh|drop the sticky bit from APP_DIR|s/    chmod 1775 \"\${APP_DIR}\"/    chmod 0775 \"\${APP_DIR}\"/"
"|test-ensure-ownership.sh|stop re-locking deploy/, .git and .update-backup to root|s/        chown -Rh root:root -- \"\${APP_DIR}\/\${locked}\"/        :/"
"|test-ensure-ownership.sh|leave deploy/ group-writable|s/        chmod -R go-w \"\${APP_DIR}\/\${locked}\"/        :/"
"|test-ensure-ownership.sh|make .env 0664 instead of 0660|s/                chmod 0660 \"\${APP_DIR}\/.env\"/                chmod 0664 \"\${APP_DIR}\/.env\"/"
"|test-ensure-ownership.sh|drop the symlink guard on the .env chown\/chmod|s/            if \[ -e \"\${APP_DIR}\/.env\" \] \&\& \[ ! -L \"\${APP_DIR}\/.env\" \]; then/            if [ -e \"\${APP_DIR}\/.env\" ]; then/"
"|test-ensure-ownership.sh|delete an operator's root-owned .env symlink too|s/       \[ \"\$(stat -c '%U' \"\${APP_DIR}\/.env\" 2>\/dev\/null || echo root)\" = \"\${SVC_USER}\" \]; then/       true; then/"
)

total=0; undetected=0; canary_ok=0
UNDETECTED_LIST=()

for entry in "${MUTATIONS[@]}"; do
    kind="${entry%%|*}"; rest="${entry#*|}"
    suite="${rest%%|*}"; rest="${rest#*|}"
    desc="${rest%%|*}"; expr="${rest#*|}"
    total=$((total + 1))

    work="$(mktemp -d)"
    cp -a "${DEPLOY_DIR}" "${work}/deploy"

    if ! sed -i "${expr}" "${work}/deploy/lib/common.sh"; then
        echo "${C_RED}ERROR${C_OFF}  sed failed for: ${desc}" >&2
        rm -rf "${work}"; exit 2
    fi

    # A mutation that changed nothing proves nothing. Treat it as a broken
    # mutation definition rather than as a passing check.
    if cmp -s "${DEPLOY_DIR}/lib/common.sh" "${work}/deploy/lib/common.sh"; then
        echo "${C_RED}ERROR${C_OFF}  mutation matched nothing (the sed is stale): ${desc}" >&2
        echo "       expression: ${expr}" >&2
        rm -rf "${work}"; exit 2
    fi

    # The mutated library must still parse; a syntax error would fail the suite
    # for a reason that has nothing to do with the property under test.
    if ! bash -n "${work}/deploy/lib/common.sh" 2>/dev/null; then
        echo "${C_RED}ERROR${C_OFF}  mutation produced invalid bash: ${desc}" >&2
        rm -rf "${work}"; exit 2
    fi

    if run_suite "${work}" "${suite}"; then
        detected="no"
    else
        detected="yes"
    fi
    rm -rf "${work}"

    if [ "${kind}" = "CANARY" ]; then
        if [ "${detected}" = "no" ]; then
            printf '%scanary ok%s     %s\n' "${C_GREEN}" "${C_OFF}" "${desc}"
            canary_ok=1
        else
            printf '%sCANARY FAILED%s %s\n' "${C_RED}" "${C_OFF}" "${desc}"
        fi
        continue
    fi

    if [ "${detected}" = "yes" ]; then
        printf '%scaught%s        %s\n' "${C_GREEN}" "${C_OFF}" "${desc}"
    else
        printf '%sNOT DETECTED%s  %s\n' "${C_RED}" "${C_OFF}" "${desc}"
        undetected=$((undetected + 1))
        UNDETECTED_LIST+=("${suite}: ${desc}")
    fi
done

echo
if [ "${canary_ok}" -ne 1 ]; then
    cat >&2 <<'MSG'
ERROR: the canary was "detected".

A mutation that changes nothing but a comment made a suite fail, which means the
suites are failing for a reason unrelated to what is being mutated. Every
"caught" in this run is therefore suspect — they may all be the same
environmental failure wearing different names. This is the exact false green
the canary exists to catch.
MSG
    exit 2
fi

echo "Mutations: $((total - 1)), undetected: ${undetected} (plus 1 canary, correctly undetected)"
if [ "${undetected}" -ne 0 ]; then
    echo
    echo "These breakages would ship unnoticed:"
    for u in "${UNDETECTED_LIST[@]}"; do echo "  - ${u}"; done
    exit 1
fi
printf '%sEvery mutation was caught, on a tree whose control run passed and whose canary did not.%s\n' "${C_GREEN}" "${C_OFF}"
